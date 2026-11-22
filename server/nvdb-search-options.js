// Per-request selection of the retrieval layers.
//
// The config defines the defaults; one request may switch a layer off (or tune
// a knob) to A/B the layers against each other. Resolution is pure and strict:
// an unknown key, an out-of-range value, an impossible combination, or a layer
// the bound index cannot serve is an error that names the problem. A request
// never silently runs a different search than the one it asked for.
//
// The layers are the four things that actually change the ranking:
//   dense      vector lane (needs the query embedding)
//   lexical    BM25 lane over the index's lexical fields
//   diversity  per-document cap inside the native call
//   rerank     ONNX cross-encoder over the fused shortlist

const BOOLEAN_KEYS = ['dense', 'lexical', 'diversity', 'rerank', 'adaptive'];

const NUMBER_KEYS = {
    rrfK: { min: 1, integer: true },
    candidateK: { min: 1, integer: true },
    vectorWeight: { min: 0 },
    lexicalWeight: { min: 0 },
    maxPerDocument: { min: 1, integer: true },
    shortlist: { min: 1, integer: true },
    rerankWeight: { min: 0, max: 1 }
};

const SEARCH_KEYS = [...BOOLEAN_KEYS, ...Object.keys(NUMBER_KEYS)];

function isHexHashToken(t) {
    return /^[0-9a-f]{7,40}$/i.test(t) && /[0-9]/.test(t) && /[a-f]/i.test(t);
}

function isFileOrPathToken(t) {
    const clean = t.replace(/[?,.;:)"']+$/, '');
    return /[\/\\]/.test(clean) || /\.[a-z0-9]{1,5}$/i.test(clean);
}

function isCodeSymbolToken(t) {
    const clean = t.replace(/^[("'[]+|[)"'\]?,.;:]+$/g, '');
    if (!clean) return false;
    if (isHexHashToken(clean)) return true;
    if (/^#\d+$/.test(clean)) return true;
    if (/[a-z0-9]_[a-z0-9]/i.test(clean)) return true;
    if (/[a-z0-9]:[a-z0-9]/i.test(clean)) return true;
    if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/i.test(clean)) return true;
    if (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(clean)) return true;
    if (/^[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(clean)) return true;
    return false;
}

// Classify query shape into adaptive RRF weights (#87):
// - Pure exact identifiers (hashes, filenames, code symbols) let lexical lead.
// - Prose containing an embedded literal/symbol keeps both lanes strong.
// - Natural-language prose, questions, cross-lingual queries, and typos let dense lead
//   so high-DF words ("AI", "Coolkid", "machine") cannot bury vec#1.
function classifyQueryProfile(query) {
    const q = typeof query === 'string' ? query.trim() : '';
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    const hasExactToken = tokens.some(t => isCodeSymbolToken(t) || isFileOrPathToken(t));
    const hasQuotedPhrase = /"[^"]+"/.test(q);

    if (tokens.length === 1 && hasExactToken) {
        return { profile: 'exact-id', lexicalWeight: 1.0, vectorWeight: 0.2, rrfK: 20 };
    }
    if (/^"[^"]+"$/.test(q)) {
        return { profile: 'exact-phrase', lexicalWeight: 1.0, vectorWeight: 0.3, rrfK: 20 };
    }
    if (tokens.length <= 2 && tokens.some(t => isHexHashToken(t) || isFileOrPathToken(t))) {
        return { profile: 'exact-short', lexicalWeight: 1.0, vectorWeight: 0.3, rrfK: 20 };
    }
    if (hasExactToken || hasQuotedPhrase) {
        return { profile: 'mixed-exact', lexicalWeight: 0.5, vectorWeight: 1.0, rrfK: 20 };
    }
    if (tokens.length === 1) {
        return { profile: 'single-term', lexicalWeight: 0.8, vectorWeight: 1.0, rrfK: 20 };
    }
    return { profile: 'semantic', lexicalWeight: 0.3, vectorWeight: 1.0, rrfK: 20 };
}

function assertBoolean(key, value) {
    if (typeof value !== 'boolean') throw new Error(`search.${key} must be a boolean (got ${value === null ? 'null' : typeof value})`);
    return value;
}

function assertNumber(key, value, rule) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`search.${key} must be a finite number (got ${value === null ? 'null' : typeof value})`);
    }
    if (rule.integer && !Number.isInteger(value)) throw new Error(`search.${key} must be an integer (got ${value})`);
    if (value < rule.min) throw new Error(`search.${key} must be >= ${rule.min} (got ${value})`);
    if (rule.max !== undefined && value > rule.max) throw new Error(`search.${key} must be <= ${rule.max} (got ${value})`);
    return value;
}

function resolveSearchOptions({ query = null, overrides = null, hybrid, rerank, rerankerAvailable, diversityField }) {
    if (!hybrid || hybrid.enabled !== true) {
        throw new Error('per-request layers need agents.vdb.hybrid.enabled — the bound index is vector-only');
    }
    if (overrides !== null && overrides !== undefined) {
        if (typeof overrides !== 'object' || Array.isArray(overrides)) {
            throw new Error(`search must be an object (got ${Array.isArray(overrides) ? 'array' : typeof overrides})`);
        }
        for (const key of Object.keys(overrides)) {
            if (!SEARCH_KEYS.includes(key)) {
                throw new Error(`search: unknown key "${key}". Allowed: ${SEARCH_KEYS.join(', ')}`);
            }
        }
    }

    const resolved = {
        dense: true,
        lexical: true,
        diversity: Boolean(diversityField),
        rerank: Boolean(rerankerAvailable && rerank?.enabled),
        adaptive: hybrid.adaptive !== false,
        profile: 'static',
        rrfK: hybrid.rrfK,
        candidateK: hybrid.candidateK,
        vectorWeight: hybrid.vectorWeight,
        lexicalWeight: hybrid.lexicalWeight,
        maxPerDocument: hybrid.maxPerDocument,
        shortlist: rerank?.shortlist,
        rerankWeight: rerank?.weight,
        rerankTextField: rerank?.textField,
        diversityField: diversityField ?? null
    };

    for (const key of BOOLEAN_KEYS) {
        if (overrides?.[key] !== undefined) resolved[key] = assertBoolean(key, overrides[key]);
    }

    if (resolved.adaptive && resolved.dense && resolved.lexical && typeof query === 'string' && query.trim()) {
        const cls = classifyQueryProfile(query);
        resolved.profile = cls.profile;
        resolved.lexicalWeight = cls.lexicalWeight;
        resolved.vectorWeight = cls.vectorWeight;
        resolved.rrfK = cls.rrfK;
    }

    let explicitWeights = false;
    for (const [key, rule] of Object.entries(NUMBER_KEYS)) {
        if (overrides?.[key] !== undefined) {
            resolved[key] = assertNumber(key, overrides[key], rule);
            if (key === 'vectorWeight' || key === 'lexicalWeight' || key === 'rrfK') explicitWeights = true;
        }
    }
    if (explicitWeights) resolved.profile = 'explicit';

    if (!resolved.dense && !resolved.lexical) {
        throw new Error('search: dense and lexical cannot both be off — there would be no lane to search');
    }
    if (resolved.dense && resolved.vectorWeight === 0) {
        throw new Error('search: vectorWeight is 0 while dense is on — turn the dense layer off instead');
    }
    if (resolved.lexical && resolved.lexicalWeight === 0) {
        throw new Error('search: lexicalWeight is 0 while lexical is on — turn the lexical layer off instead');
    }
    if (resolved.diversity && !resolved.diversityField) {
        throw new Error('search: the diversity layer is on but this collection has no group field configured');
    }
    if (resolved.rerank && !rerankerAvailable) {
        throw new Error(rerank?.enabled
            ? 'search: rerank is on but nvdb serve has no reranker loaded — start nvdb serve with --reranker-model'
            : 'search: rerank is on but agents.vdb.rerank.enabled is false');
    }
    return resolved;
}

// Compact, stable description for the tool output: an A/B run must be
// attributable from the transcript alone.
function describeSearchOptions(options) {
    const layers = [
        options.dense && 'dense',
        options.lexical && 'lexical',
        options.diversity && 'diversity',
        options.rerank && 'rerank'
    ].filter(Boolean);
    const profilePart = options.profile ? ` profile=${options.profile}` : '';
    return `layers=${layers.join('+')}${profilePart} rrfK=${options.rrfK} candidateK=${options.candidateK} v=${options.vectorWeight} l=${options.lexicalWeight}`
        + (options.diversity ? ` mpd=${options.maxPerDocument}` : '')
        + (options.rerank ? ` short=${options.shortlist} w=${options.rerankWeight}` : '');
}

module.exports = {
    SEARCH_KEYS,
    classifyQueryProfile,
    resolveSearchOptions,
    describeSearchOptions,
};
