// ------------------------------------------------------------------ //
// Kimi command matcher — LOCAL, no gateway.                           //
//                                                                     //
// The command vocabulary is fixed and tiny: listen / stop / send. An  //
// LLM is not needed to understand it (and would only see parakeet's   //
// output anyway). Parakeet auto-detects language and often drifts to  //
// Russian on a single short word; Russian borrowed "стоп" (stop), so  //
// Cyrillic→Latin normalization makes the misdetected forms match the  //
// English words. Word-boundary matching rejects false hits            //
// ("stopwatch" ≠ "stop").                                             //
// ------------------------------------------------------------------ //
const _KIMI_CYR_TO_LAT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

// Match priority: stop > send > listen ("stop listening" must stop, not listen).
const _KIMI_COMMAND_PHRASES = [
    ['stop',   ['stop', 'stopp', 'stoppen', 'halt']],
    ['send',   ['send', 'sende', 'zend', 'sen']],
    ['listen', ['listen', 'listening', 'lissin', 'listun']],
];

function _kimiNormalize(raw) {
    let out = '';
    for (const ch of String(raw || '').toLowerCase()) {
        const c = _KIMI_CYR_TO_LAT[ch];
        if (c !== undefined) out += c;
        else if (/[a-z0-9]/.test(ch)) out += ch;
        else out += ' ';  // punctuation/space → separator
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Match a raw STT command utterance to one of the fixed commands.
 * Returns 'listen' | 'stop' | 'send' | null (null = not a command).
 */
function _kimiMatchCommand(text) {
    const norm = _kimiNormalize(text);
    if (!norm) return null;
    for (const [action, phrases] of _KIMI_COMMAND_PHRASES) {
        for (const p of phrases) {
            const np = _kimiNormalize(p);
            const re = new RegExp('\\b' + np.replace(/\s+/g, '\\s+') + '\\b');
            if (re.test(norm)) return action;
        }
    }
    return null;
}

// ------------------------------------------------------------------ //
// Turn trace — turn-taking session record and diagnostics.            //
//                                                                     //
// Turn-taking is a server-side pipeline that only reveals itself as a  //
// sequence of frames. Too much happens between a final transcript and  //
// a finished reply to follow by ear, so an intent session records      //
// every frame with an offset from its start, groups the frames into     //
// turns, and derives a findings list from the result.                  //
//                                                                     //
// Consumers get two high-level events for UI binding:                   //
//   'turn'      — turn state changed (listening → classified → … → done)//
//   'turn-end'  — a turn completed, with its texts and timings          //
// When the socket closes a report is printed to the console and left on //
// `lastReport`, so a session can be diagnosed without a debugger.       //
// ------------------------------------------------------------------ //
const TURN_SLOW_CLASSIFIER_MS = 500;
const TURN_SLOW_CLEANUP_MS = 1500;
const TURN_SLOW_TTFB_MS = 2500;
const TURN_LONG_FINAL_GAP_MS = 5000;

// Mirrors the turn machine's server-side INTERRUPT_RE. An explicit interrupt word is
// evidence rather than a guess, so the client acts on it immediately instead of
// waiting out the sustain window that exists to filter noise. Leading fillers are
// allowed ("äh wait") because STT merges them into the same final.
// стоп = "Stopp" transcribed as Russian (multilingual STT). Unicode lookahead
// boundary — \b is ASCII-only and would never match at a Cyrillic word edge.
const _BARGE_IN_RE = /^\s*(?:(?:uh|um|ah|oh|äh|ähm|ehm|hm|ja|so|und|aber|and)\s+)*(wait|stop|halt|stopp|schtop|shtop|стоп|warte|warte mal|moment|moment mal|hold on|hold up|never ?mind|belay that|vergiss es)(?![\p{L}\p{N}])/iu;

function _turnTraceNew(meta) {
    return {
        t0: Date.now(),
        startedAt: new Date().toISOString(),
        config: meta,
        seq: 0,
        open: null,
        turns: [],
        log: [],
        findings: [],
        errors: [],
        lastFinalAtMs: null,
    };
}

function _turnMs(trace) {
    return trace ? Date.now() - trace.t0 : 0;
}

function _turnLog(trace, text) {
    if (trace) trace.log.push({ atMs: _turnMs(trace), s: text });
}

function _turnFind(trace, code, detail, severity = 'warn', turnIndex = null) {
    if (trace) trace.findings.push({ code, severity, turnIndex, detail, atMs: _turnMs(trace) });
}

function _turnOpen(trace, seedFinals) {
    if (!trace) return null;
    if (!trace.open) {
        trace.seq += 1;
        trace.open = {
            index: trace.seq,
            startMs: _turnMs(trace),
            endMs: null,
            outcome: 'open',
            stage: 'speech',
            finals: seedFinals || [],
            lateFinals: [],
            intent: null,
            phases: [],
            cleaned: null,
            reply: null,
            interruptedText: null,
        };
    }
    return trace.open;
}

/**
 * Close the open turn. 
 *
 * `still-speaking` keeps the turn OPEN and asks for more speech, so later finals
 * belong to the SAME turn — the server accumulates them and re-classifies the
 * whole text. Only once the turn is committed (turn-done, or a phase has begun)
 * does fresh speech start the next turn. Getting this wrong splits one utterance
 * across two turns and reports the second half as "buffered".
 */
function _turnClose(trace, outcome) {
    const t = trace && trace.open;
    if (!t) return null;
    t.outcome = outcome;
    t.endMs = _turnMs(trace);
    _turnLog(trace, `turn #${t.index} ${outcome} ${((t.endMs - t.startMs) / 1000).toFixed(1)}s · ${t.finals.length} finals · ${t.reply ? `reply ${t.reply.chars}c/${t.reply.chunks} chunks` : 'no reply'}`);
    trace.turns.push(t);
    trace.open = null;
    if (t.lateFinals.length) {
        const next = _turnOpen(trace, t.lateFinals);
        next.startMs = t.lateFinals[0].atMs;
        _turnLog(trace, `turn #${next.index} opened from ${next.finals.length} buffered final(s)`);
    }
    return t;
}

function _turnRecordFinal(trace, text) {
    const atMs = _turnMs(trace);
    const clean = String(text || '').trim();
    const wasOpen = !!trace.open;
    const t = _turnOpen(trace);
    if (t.stage === 'speech') {
        t.finals.push({ atMs, text: clean, gapMs: trace.lastFinalAtMs == null ? null : atMs - trace.lastFinalAtMs });
        _turnLog(trace, `final "${clean}"${clean ? '' : ' (EMPTY)'}`);
    } else {
        t.lateFinals.push({ atMs, text: clean });
        _turnLog(trace, `final "${clean}" (buffered — turn #${t.index} is ${t.stage})`);
    }
    if (!clean) _turnFind(trace, 'empty-final', 'is_final arrived with empty text', 'warn', t.index);
    trace.lastFinalAtMs = atMs;
    return { turn: t, started: !wasOpen };
}

function _turnRecordIntent(trace, data, latencyMs) {
    const t = _turnOpen(trace);
    if (!t) return null;
    t.intent = {
        atMs: _turnMs(trace),
        label: data.label,
        pauseMs: data.pause_ms,
        latencyMs,
        forced: !!data.forced,
        trailing: !!data.trailing,
        text: data.text || '',
    };
    // `trailing` / forced results never call the classifier, so their latency is
    // meaningless — and the turn is still collecting, not committing.
    const classified = !data.forced && !data.trailing;
    t.intent.classified = classified;
    t.stage = data.label === 'still-speaking' ? 'speech' : 'processing';
    const how = data.forced ? ' (forced)' : data.trailing ? ' (trailing — no classifier call)' : '';
    _turnLog(trace, `intent ${data.label}${how} pause=${data.pause_ms}ms lat=${latencyMs}ms "${(data.text || '').slice(-60)}"`);
    if (data.forced) _turnFind(trace, 'forced-completion', `silence ceiling forced turn-done after ${data.pause_ms}ms`, 'info', t.index);
    if (data.trailing) _turnFind(trace, 'classifier-skipped', `text ends on a trailing word — decided locally, no classifier call`, 'info', t.index);
    if (classified && latencyMs > TURN_SLOW_CLASSIFIER_MS) _turnFind(trace, 'slow-classifier', `classifier took ${latencyMs}ms (over ${TURN_SLOW_CLASSIFIER_MS}ms)`, 'warn', t.index);
    return t;
}

function _turnRecordVerdict(trace, data) {
    const t = _turnOpen(trace);
    if (!t) return null;
    t.verdict = {
        atMs: _turnMs(trace),
        verdict: data.verdict,
        forced: !!data.forced,
        superseded: !!data.superseded,
        parseFailed: !!data.parse_failed,
        latencyMs: data.latency_ms ?? null,
        text: data.text || '',
    };
    const how = data.superseded ? ' (SUPERSEDED — dropped)' : data.parse_failed ? ' (parse failed — fail-safe)' : '';
    _turnLog(trace, `verdict ${data.verdict}${how} lat=${data.latency_ms ?? '?'}ms "${(data.text || '').slice(-60)}"`);
    if (data.verdict === 'NOT_SPEECH' && !data.superseded) {
        _turnFind(trace, 'noise-discarded', 'turn had no communicative content — buffer discarded, nothing sent', 'info', t.index);
    }
    if (data.parse_failed) _turnFind(trace, 'verdict-parse-failed', 'verdict line unparseable — fail-safe COMPLETE sent raw/cleaned text', 'warn', t.index);
    if (data.latency_ms > TURN_SLOW_CLEANUP_MS) _turnFind(trace, 'slow-verdict', `verdict call took ${data.latency_ms}ms (over ${TURN_SLOW_CLEANUP_MS}ms)`, 'warn', t.index);
    return t;
}

function _turnRecordPhase(trace, data) {
    const t = _turnOpen(trace);
    if (!t) return { turn: null, closed: null };
    const p = data.phase;
    t.phases.push({ phase: p, atMs: _turnMs(trace), ttfbMs: data.ttfb_ms ?? null, durationMs: data.duration_ms ?? null });
    _turnLog(trace, `phase ${p}${data.ttfb_ms != null ? ` ttfb=${data.ttfb_ms}ms` : ''}${data.duration_ms != null ? ` duration=${data.duration_ms}ms` : ''}${data.text ? ` text="${data.text}"` : ''}`);
    if (p === 'done') return { turn: t, closed: _turnClose(trace, 'turn-done') };
    if (p === 'interrupted') {
        t.interruptedText = data.text || '';
        return { turn: t, closed: _turnClose(trace, 'interrupted') };
    }
    if (p === 'reopened') {
        // Speech resumed during cleanup, so the send was abandoned. The turn is
        // still collecting: later finals belong to THIS turn, and the stale
        // turn-done verdict no longer describes it. Finals that arrived before
        // this notice was filed as "late" (the client cannot know the server
        // appended them until it is told) — take them back.
        t.stage = 'speech';
        t.intent = null;
        if (t.lateFinals.length) {
            t.finals.push(...t.lateFinals);
            t.lateFinals = [];
            _turnLog(trace, `turn #${t.index} reclaimed buffered speech (turn reopened)`);
        }
        _turnFind(trace, 'cleanup-discarded', 'speech resumed during cleanup — the cleaned text was never sent, turn reopened', 'info', t.index);
    }
    return { turn: t, closed: null };
}

function _turnRecordReply(trace, r) {
    const t = trace.open;
    if (!t) {
        _turnLog(trace, `reply "${r.type}" with NO open turn`);
        _turnFind(trace, 'orphan-reply', `reply "${r.type}" arrived with no open turn`, 'warn');
        return null;
    }
    if (r.type === 'cleaned') {
        t.cleaned = { atMs: _turnMs(trace), text: r.text || '', latencyMs: r.latency_ms ?? null };
        _turnLog(trace, `reply cleaned ${r.latency_ms != null ? r.latency_ms + 'ms' : '(no latency)'} "${(r.text || '').slice(0, 70)}"`);
        if (t.cleaned.latencyMs != null && t.cleaned.latencyMs > TURN_SLOW_CLEANUP_MS) {
            _turnFind(trace, 'slow-cleanup', `cleanup took ${t.cleaned.latencyMs}ms (over ${TURN_SLOW_CLEANUP_MS}ms)`, 'warn', t.index);
        }
    } else if (r.type === 'stream') {
        if (!t.reply) {
            t.reply = { atMs: _turnMs(trace), chunks: 0, chars: 0, text: '' };
            _turnLog(trace, 'reply stream first token');
        }
        t.reply.chunks += 1;
        t.reply.chars += (r.text || '').length;
        t.reply.text += r.text || '';
    } else {
        _turnFind(trace, 'unknown-reply-type', `reply type "${r.type}" is not handled`, 'warn', t.index);
    }
    return t;
}

function _turnStats(values) {
    const v = values.filter(n => n != null && !Number.isNaN(n)).sort((a, b) => a - b);
    if (!v.length) return { n: 0, min: null, median: null, max: null };
    return {
        n: v.length,
        min: Math.round(v[0]),
        median: Math.round(v[Math.floor(v.length / 2)]),
        max: Math.round(v[v.length - 1]),
    };
}

/** Shallow per-turn view for consumers — the state the chat app binds to. */
function _turnSnapshot(t, state) {
    if (!t) return null;
    const streamPhase = t.phases.find(p => p.phase === 'streaming');
    const donePhase = t.phases.find(p => p.phase === 'done');
    return {
        index: t.index,
        state,
        outcome: t.outcome,
        rawText: t.finals.map(f => f.text).join(' ').trim(),
        intent: t.intent ? { label: t.intent.label, pauseMs: t.intent.pauseMs, latencyMs: t.intent.latencyMs, forced: t.intent.forced } : null,
        cleanedText: t.cleaned ? t.cleaned.text : null,
        replyText: t.reply ? t.reply.text : '',
        ttfbMs: streamPhase ? streamPhase.ttfbMs : null,
        replyDurationMs: donePhase ? donePhase.durationMs : null,
        startedAtMs: t.startMs,
        endedAtMs: t.endMs,
    };
}

function _turnState(t) {
    if (!t) return null;
    if (t.outcome !== 'open') return t.outcome === 'turn-done' ? 'done' : t.outcome;
    if (t.phases.length) {
        const last = t.phases[t.phases.length - 1].phase;
        return last === 'reopened' ? 'listening' : last;
    }
    return t.intent ? 'classified' : 'listening';
}

// ------------------------------------------------------------------ //
// The report: what actually happened, in an order a reader can follow. //
// Findings come first — they are the answer to "why did it fail".     //
// ------------------------------------------------------------------ //
function _buildTurnReport(trace) {
    if (!trace) return null;

    const allTurns = [...trace.turns];
    if (trace.open) {
        // The open turn is unfinished by definition — the session ended mid-flight.
        allTurns.push({ ...trace.open, outcome: 'unfinished', endMs: _turnMs(trace) });
    }

    const clf = [], clean = [], ttfb = [];
    const report = {
        schema: 'nvoice.turn-report/1',
        startedAt: trace.startedAt,
        durationMs: _turnMs(trace),
        config: trace.config,
        counts: { turns: 0, finals: 0, intentEvents: 0, phaseEvents: 0, cleaned: 0, replyChunks: 0, errors: trace.errors.length },
        latency: {},
        findings: [...trace.findings],
        turns: [],
        timeline: trace.log,
    };

    for (const t of allTurns) {
        const streamPhase = t.phases.find(p => p.phase === 'streaming');
        const donePhase = t.phases.find(p => p.phase === 'done');
        const out = {
            index: t.index,
            outcome: t.outcome,
            stage: t.stage,
            startMs: t.startMs,
            endMs: t.endMs,
            durationMs: t.endMs != null ? t.endMs - t.startMs : null,
            raw: t.finals.map(f => f.text).join(' ').trim(),
            finals: t.finals,
            lateFinals: t.lateFinals,
            intent: t.intent,
            phases: t.phases.map(p => p.phase),
            ttfbMs: streamPhase ? streamPhase.ttfbMs : null,
            replyDurationMs: donePhase ? donePhase.durationMs : null,
            pauseMs: t.intent ? t.intent.pauseMs : null,
            pauseGapMs: t.intent && t.finals.length ? Math.round(t.intent.atMs - t.finals[t.finals.length - 1].atMs) : null,
            cleaned: t.cleaned ? { text: t.cleaned.text, latencyMs: t.cleaned.latencyMs } : null,
            reply: t.reply ? { chars: t.reply.chars, chunks: t.reply.chunks, text: t.reply.text } : null,
            interruptedText: t.interruptedText,
        };
        report.turns.push(out);

        report.counts.turns += 1;
        report.counts.finals += t.finals.length;
        report.counts.phaseEvents += t.phases.length;
        if (t.intent) report.counts.intentEvents += 1;
        // Only real classifier calls have a meaningful latency; `trailing` and
        // forced results are decided locally and report 0.
        if (t.intent && t.intent.classified) clf.push(t.intent.latencyMs);
        if (t.cleaned) { report.counts.cleaned += 1; clean.push(t.cleaned.latencyMs); }
        if (t.reply) report.counts.replyChunks += t.reply.chunks;
        if (out.ttfbMs != null) ttfb.push(out.ttfbMs);

        const add = (code, detail, severity = 'warn') => report.findings.push({ code, severity, turnIndex: t.index, detail, atMs: t.endMs ?? t.startMs });

        if (t.outcome === 'unfinished') {
            add('unfinished-turn', `turn never reached done/interrupted — last phase ${t.phases.length ? t.phases[t.phases.length - 1].phase : '(none)'}, stage ${t.stage}`);
            if (t.lateFinals.length) add('speech-lost-at-stop', `${t.lateFinals.length} buffered final(s) never processed`);
        }
        if (!t.intent && t.finals.length) {
            add('no-intent', `${t.finals.length} final(s) but the classifier never returned a label`, 'error');
        }
        if (t.intent && t.intent.label === 'still-speaking') {
            const continued = t.finals.length > 1 || t.lateFinals.length > 0;
            if (t.outcome === 'turn-done' && !continued) add('still-speaking-then-forced', 'classifier said still-speaking, no further speech arrived, turn ended anyway', 'info');
            if (t.outcome === 'unfinished' && !continued) add('still-speaking-dead-end', 'classifier said still-speaking and the session ended with no continuation');
        }
        if (t.outcome === 'turn-done') {
            if (!t.phases.some(p => p.phase === 'cleaning')) add('cleanup-phase-skipped', 'no cleaning phase before the turn ended', 'info');
            if (!t.cleaned) add('no-cleanup-text', 'turn-done but no cleaned transcript was delivered', 'error');
            if (trace.config.generateReply && !t.reply) add('no-reply', 'turn-done but no assistant reply tokens arrived', 'error');
            if (t.reply && out.ttfbMs == null) add('no-ttfb', 'reply streamed but no ttfb_ms was reported', 'info');
            if (out.ttfbMs != null && out.ttfbMs > TURN_SLOW_TTFB_MS) add('slow-ttfb', `ttfb ${out.ttfbMs}ms (over ${TURN_SLOW_TTFB_MS}ms)`);
        }
        if (t.outcome === 'interrupted') {
            if (t.reply && t.reply.chars) add('interrupt-dropped', `barge-in mid-stream — ${t.reply.chars} chars kept, trigger "${t.interruptedText}"`, 'info');
            else add('spurious-interrupt', `barge-in with no reply in flight — trigger "${t.interruptedText}"`);
        }
        const gaps = t.finals.map(f => f.gapMs).filter(g => g != null && g > TURN_LONG_FINAL_GAP_MS);
        if (gaps.length) add('long-final-gap', `speech resumed after ${Math.max(...gaps)}ms of silence between finals`, 'info');
    }

    if (!report.counts.finals) {
        addReportFinding(report, 'no-speech', 'no final transcript ever arrived — nothing reached the server', 'error');
    } else if (!report.counts.intentEvents) {
        addReportFinding(report, 'classifier-never-ran', `${report.counts.finals} finals but zero classifier results`, 'error');
    }
    for (const e of trace.errors) addReportFinding(report, 'ws-error', e, 'error');

    report.latency = {
        classifier: _turnStats(clf),
        cleanup: _turnStats(clean),
        ttfb: _turnStats(ttfb),
    };
    return report;
}

function addReportFinding(report, code, detail, severity) {
    report.findings.push({ code, severity, turnIndex: null, detail, atMs: report.durationMs });
}

function _turnStatLine(s) {
    return s.n ? `${s.n} · ${s.min}/${s.median}/${s.max}ms` : 'none';
}

function _renderTurnReport(r) {
    const L = [];
    L.push(`── turn-taking session · ${(r.durationMs / 1000).toFixed(1)}s · ${r.counts.turns} turns ──`);
    L.push(`   engine ${r.config.engine} · pause ${r.config.pauseMs ?? '--'}ms · maxSilence ${r.config.maxSilenceMs ?? '--'}ms · reply ${r.config.generateReply ? 'on' : 'off'}`);
    L.push(`   finals ${r.counts.finals} · intents ${r.counts.intentEvents} · cleaned ${r.counts.cleaned} · replyChunks ${r.counts.replyChunks} · errors ${r.counts.errors}`);
    L.push(`   classifier ${_turnStatLine(r.latency.classifier)} · cleanup ${_turnStatLine(r.latency.cleanup)} · ttfb ${_turnStatLine(r.latency.ttfb)}`);
    L.push('FINDINGS');
    if (r.findings.length) {
        for (const f of r.findings) {
            L.push(`   [${f.severity}] ${(f.atMs / 1000).toFixed(1)}s ${f.code}${f.turnIndex ? ` turn#${f.turnIndex}` : ''} — ${f.detail}`);
        }
    } else {
        L.push('   (none)');
    }
    L.push('TURNS');
    for (const t of r.turns) {
        const bits = [`#${t.index} ${t.outcome}`, `${(t.startMs / 1000).toFixed(1)}→${t.endMs != null ? (t.endMs / 1000).toFixed(1) : '?'}s`, `${t.finals.length}f`];
        if (t.intent) bits.push(`clf ${t.intent.label}${t.intent.forced ? '/forced' : t.intent.trailing ? '/trailing' : ''}${t.intent.classified ? ` ${t.intent.latencyMs}ms` : ' (no call)'}`);
        if (t.cleaned) bits.push(`clean ${t.cleaned.latencyMs != null ? t.cleaned.latencyMs + 'ms' : '--'}`);
        if (t.ttfbMs != null) bits.push(`ttfb ${t.ttfbMs}ms`);
        bits.push(t.reply ? `reply ${t.reply.chars}c` : 'reply none');
        if (t.lateFinals.length) bits.push(`+${t.lateFinals.length} buffered`);
        L.push(`   ${bits.join(' · ')}`);
        if (t.raw) L.push(`        said:  "${t.raw.slice(0, 160)}"`);
        if (t.cleaned?.text && t.cleaned.text !== t.raw) L.push(`        clean: "${t.cleaned.text.slice(0, 160)}"`);
        if (t.reply?.text) L.push(`        reply: "${t.reply.text.slice(0, 160)}"`);
    }
    const tail = r.timeline.slice(-50);
    L.push(`TIMELINE (${r.timeline.length} events, last ${tail.length})`);
    for (const e of tail) L.push(`   ${(e.atMs / 1000).toFixed(2)}s  ${e.s}`);
    return L.join('\n');
}

class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || '';
        // R1: basePath allows the SDK to run behind a same-origin relay
        // (chat app /api/stt/*). All request URLs derive from serverUrl+basePath.
        this.basePath = (config.basePath || '').replace(/\/+$/, '');
        this.audioDeviceId = config.audioDeviceId || null;
        this.rawAudio = config.rawAudio || false;
        // R4: force browser AEC/NS/AGC on every platform (assistant mode plays
        // TTS with the mic open — without AEC the assistant transcribes itself).
        this.audioProcessing = config.audioProcessing || false;
        this.engine = config.engine || null;
        this.recordDebug = config.recordDebug || false;  // worker captures engine-received audio
        this.assistantEnabled = config.assistantEnabled || false;  // opt into LLM post-processing
        this.intentEnabled = config.intentEnabled || false;  // opt into turn-intent classification
        this.speaking = false;   // user VAD state — see the 'speech-start' event
        // Barge-in requires speech held for this long. The server reports only one
        // 'processing' telemetry frame per transcription, so touching the mic, a
        // door, or handling noise trips the VAD for one or two frames — enough to
        // cut the assistant off mid-sentence if a single transition were trusted.
        // Measured in a live room: ambient noise held the gate for 430-550ms, so the
        // threshold has to sit above that. Same reasoning as the wake-word gate.
        this.bargeInMs = config.bargeInMs ?? 1000;
        // v2 duck threshold: voiced milliseconds before playback ducks (not
        // stops). Well under the old hard-stop bar — ducking is cheap and
        // reversible, so acknowledging speech early costs nothing; a cough
        // under ~400ms doesn't even dent the level.
        this.duckMs = config.duckMs ?? 400;
        this._ducked = false;
        this._speechStartedAt = null;
        this._bargeInFired = false;

        // Mic DSP, individually overridable (undefined = derive from `rawAudio`/
        // `isMobile` as before). They are not one kind of help:
        //   echoCancellation — keeps the assistant from hearing its own TTS. Wanted.
        //   autoGainControl  — raises gain when the room is quiet, which lifts the
        //                      noise floor into the range the VAD then calls speech.
        //   noiseSuppression — tuned for far-end speech, not for feeding an ASR.
        this.echoCancellation = config.echoCancellation;
        this.noiseSuppression = config.noiseSuppression;
        this.autoGainControl = config.autoGainControl;

        // A realtime connect that never completes must not hang forever: the socket
        // can sit in CONNECTING while the engine worker loads, with nothing to fail
        // on. Past this the connect is abandoned loudly.
        this.connectTimeoutMs = config.connectTimeoutMs || 20000;

        // Turn-taking record (intent sessions only). `turn` is the live snapshot a
        // consumer binds to; a report is printed on socket close and left on
        // `lastReport` so a session can be diagnosed after the fact.
        this._trace = null;
        this._turnSig = null;
        this._disconnected = false;
        this.turn = null;
        this.lastReport = null;
        this.lastReportText = null;

        // R2: raw transcript buffer — every non-command final, in speak order.
        this._rawFinals = '';

        this.ws = null;             // local realtime WebSocket (browser → Node → worker)
        this.audioStream = null;
        this._streamNode = null;    // AudioWorkletNode feeding PCM frames to this.ws
        this._streamContext = null; // AudioContext for _streamNode

        // VAD state (Silero V4 legacy model from vad-web)
        // Model inputs:  input[1,N], sr[int64], h[2,1,64], c[2,1,64]
        // Model outputs: output[1,1], hn[2,1,64], cn[2,1,64]
        this.wakeWordEnabled = false;
        this.isAwake = true;
        this.wwSession = null;
        this.wwH = null;
        this.wwC = null;
        this.wwSr = null;
        this.audioContext = null;
        this.workletNode = null;
        this._vadChain = Promise.resolve();

        // Auto-sleep: after a final transcript, count consecutive silence frames
        // 1536 samples @ 16kHz = 96ms/frame, so ~31 frames = ~3s silence
        this._finalReceived = false;
        this._silenceCount = 0;
        this._silenceFramesToSleep = 31;
        this._silenceThreshold = 0.3;

        // Kimi-mode state machine (Phase 4). After "ok kimi" wakes the client it
        // captures the NEXT utterance as a command and matches it LOCALLY
        // (no gateway): "listen" → transcribing | "stop" → sleep+discard |
        // "send" → sleep+submit | anything else → ignore.
        //   sleep        → "ok kimi" → command (capture one utterance → match)
        //   command      → listen → transcribing | stop → sleep | send → sleep+submit
        //   transcribing → "ok kimi" (interrupt) → command (capture stop/send)
        // The kimi WS is always listening, so "ok kimi" interrupts transcription.
        // NOTE: the wake detector can false-fire on speech-like audio during
        // dictation (~11% adversarial FA). When that happens the captured
        // "command" matches NO command word — which means it was dictation, not
        // a command. We then RESUME transcribing instead of responding (see
        // _kimiInterruptedTranscribing).
        this._kimiState = 'sleep';          // sleep | command | transcribing
        this._kimiCommandText = '';         // current command utterance (raw STT)
        this._kimiCommandFinal = false;     // a final landed for the current command
        this._kimiDictationText = '';       // accumulated dictation (for send)
        this._kimiIdleCount = 0;            // idle/silence telemetry beats since last final
        this._kimiIdleToClassify = 3;       // idle beats before classifying the command
        this._kimiClassifying = false;      // re-entrancy guard for async classify
        this._kimiInterruptedTranscribing = false;  // wake came mid-dictation
        this._kimiCommandTimer = null;      // command-state timeout (self-heal false wakes)

        // Wake-on-voice: require SUSTAINED speech to wake (rejects fan/ambient noise)
        this._wakeThreshold = 0.5;   // per-frame Silero prob to count toward wake
        this._wakeFrames = 3;        // consecutive frames needed to wake (~96ms)
        this._wakeCount = 0;

        // Endpointing (hang-up): close the gate after sustained non-speech so the
        // backend goes idle. Per industry research (Pipecat turn-stop strategy):
        // the countdown resets ONLY on confident speech (prob >= reset threshold),
        // so a noise burst's decay tail (mid prob) counts toward hang-up instead of
        // resetting it. Window ~2s (research's 1.5–3.0s dictation guidance).
        this._hangupResetProb = 0.5;  // prob >= this = confident speech → reset countdown
        this._hangupFrames = 20;      // ~20 × 96ms ≈ 2s of non-confident-speech → close
        this._hangupCount = 0;

        // Recording: capture the exact 16kHz frames the pipeline sends (post-worklet)
        this._recording = false;
        this._recordedChunks = [];

        // Assistant layer: segment store + action handlers
        this.segments = [];
        this._actions = {};

        this.listeners = {};
    }

    /**
     * R1: one derivation for every request URL.
     * httpBase — for fetch() calls (session, cleanup).
     * wsBase  — protocol+host part for WebSocket URLs.
     * serverUrl set → derive ws proto from it; serverUrl '' (same-origin,
     * possibly behind a relay) → derive from window.location.
     */
    _apiBase() {
        const bp = this.basePath;
        if (this.serverUrl) {
            const wsProto = this.serverUrl.startsWith('https') ? 'wss:'
                : this.serverUrl.startsWith('http') ? 'ws:' : null;
            if (!wsProto) throw new Error(`serverUrl must start with http:// or https:// (got "${this.serverUrl}")`);
            let host = this.serverUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            return { httpBase: this.serverUrl + bp, wsBase: `${wsProto}//${host}${bp}` };
        }
        const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        return { httpBase: bp, wsBase: `${proto}//${window.location.host}${bp}` };
    }

    /**
     * R2: the accumulated raw transcript (every non-command final in speak
     * order). Reset with clearRawText(). The dictation flow cleans this on Done.
     */
    getRawText() {
        return this._rawFinals.trim();
    }

    clearRawText() {
        this._rawFinals = '';
    }

    /**
     * R2: one-shot LLM cleanup via POST /v1/audio/cleanup.
     * Fail-loud: throws on HTTP errors — the app shows the error and keeps
     * the raw text. Returns the cleaned string.
     */
    async cleanup(text, mode = 'clean') {
        const trimmed = (text || '').trim();
        if (!trimmed) throw new Error('cleanup: text required');
        const { httpBase } = this._apiBase();
        const resp = await fetch(`${httpBase}/v1/audio/cleanup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: trimmed, mode }),
        });
        if (!resp.ok) {
            let msg = `cleanup failed: HTTP ${resp.status}`;
            try { const j = await resp.json(); if (j?.error?.message) msg += ` — ${j.error.message}`; } catch {}
            throw new Error(msg);
        }
        const data = await resp.json();
        if (typeof data.text !== 'string') throw new Error('cleanup: malformed response (missing text)');
        return data.text;
    }

    /**
     * Start/stop capturing the pipeline's 16kHz mono frames into a buffer.
     * These are the SAME frames sent to the backend — post-worklet, post any
     * browser processing — so a recording reflects exactly what the STT hears.
     */
    startRecording() {
        this._recordedChunks = [];
        this._recording = true;
    }

    stopRecording() {
        this._recording = false;
    }

    get isRecording() { return this._recording; }

    /**
     * Build a WAV (16kHz mono PCM16) blob from the recorded frames.
     */
    recordingToWavBlob() {
        const chunks = this._recordedChunks;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const pcm = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { pcm.set(c, off); off += c.length; }

        // float32 [-1,1] → int16 PCM
        const pcm16 = new Int16Array(total);
        for (let i = 0; i < total; i++) {
            const s = Math.max(-1, Math.min(1, pcm[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const sampleRate = 16000, numCh = 1, bytesPerSample = 2;
        const dataLen = pcm16.length * bytesPerSample;
        const buf = new ArrayBuffer(44 + dataLen);
        const v = new DataView(buf);
        const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        wstr(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
        wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
        v.setUint16(32, numCh * bytesPerSample, true); v.setUint16(34, 16, true);
        wstr(36, 'data'); v.setUint32(40, dataLen, true);
        new Int16Array(buf, 44).set(pcm16);
        return new Blob([buf], { type: 'audio/wav' });
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    // --- Turn-taking session record -------------------------------------
    //
    // Turn-taking is server-side and only observable as a frame sequence, so the
    // client records it. Integration surface:
    //   'turn'           state changed — bind UI to the snapshot
    //   'turn-end'       a turn completed, with texts and timings
    //   'session-report' a report is ready (also printed to the console)
    //   client.turn      live snapshot · client.lastReport  last full report

    /**
     * Emit 'turn' when the turn's state changes. Reply tokens keep flowing through
     * the `reply` event — this fires on transitions only, never per token.
     */
    _syncTurn() {
        const trace = this._trace;
        if (!trace) return;
        const t = trace.open || trace.turns[trace.turns.length - 1];
        if (!t) return;
        const state = _turnState(t);
        const sig = `${t.index}:${state}:${t.outcome}`;
        if (sig === this._turnSig) return;
        this._turnSig = sig;
        this.turn = _turnSnapshot(t, state);
        this.emit('turn', this.turn);
    }

    /**
     * Declare a barge-in. Fired either because speech has been sustained past
     * `bargeInMs`, or because an interrupt keyword arrived — which needs no waiting,
     * since the word itself is the evidence.
     *
     * A keyword is NEVER suppressed by an earlier barge-in in the same speech run.
     * That latch previously swallowed a spoken "stop": it resets only on a
     * silence → speech edge, and playback plus room noise can keep the server
     * reporting "processing" straight through, so there was no edge to reset it. The
     * debounce covers a repeated word instead.
     */
    _fireBargeIn(heldMs, reason) {
        const now = Date.now();
        if (reason === 'keyword') {
            if (now - (this._lastBargeInAt || 0) < 800) return;
        } else if (this._bargeInFired) {
            return;
        }
        this._bargeInFired = true;
        this._lastBargeInAt = now;
        this.emit('barge-in', { heldMs, reason });
    }

    /**
     * Annotate the session record from the application — for behaviour the SDK
     * cannot observe itself, such as assistant audio playback or a UI decision.
     * Lands in the report as a finding on the current turn.
     *
     * @param {string} code - short finding code (e.g. 'playback-cut')
     * @param {string} detail - what happened
     * @param {'info'|'warn'|'error'} [severity='info']
     */
    note(code, detail, severity = 'info') {
        if (!this._trace) return;
        const t = this._trace.open || this._trace.turns[this._trace.turns.length - 1];
        _turnFind(this._trace, code, detail, severity, t ? t.index : null);
    }

    /**
     * Structured record of the current turn-taking session, or null when this
     * client never ran an intent session. Safe to call repeatedly — the open turn
     * is closed on a copy, so the trace itself is never mutated.
     *
     * @returns {Object|null}
     */
    getSessionReport() {
        return this._trace ? _buildTurnReport(this._trace) : null;
    }

    /**
     * Build, print and cache the session report. Called automatically when the
     * realtime socket closes; call it manually to snapshot a live session.
     *
     * @param {string} reason - Why the report was taken (shown in the console header)
     * @returns {Object|null} The report, also left on `this.lastReport`
     */
    printSessionReport(reason = 'manual') {
        const trace = this._trace;
        if (!trace) return null;
        // Nothing the socket ever reported means there is no session to describe.
        // An open socket with no speech is still worth a report — "no final
        // transcript ever arrived" is the finding you want when nothing works.
        if (!trace.log.length && !trace.turns.length && !trace.open && !trace.errors.length) return null;
        const report = this.getSessionReport();
        const text = _renderTurnReport(report);
        this.lastReport = report;
        this.lastReportText = text;
        console.log(`[nVoice] turn-taking session report (${reason})\n${text}`);
        this.emit('session-report', report);
        return report;
    }

    // --- Assistant layer (LLM-powered transcription post-processing) ---

    /**
     * Segment store — tracks all transcript segments (raw + corrected).
     * Segments are non-destructive: removed segments stay in the array
     * with status "removed" for undo support.
     *
     * Segment shape:
     *   { id, raw, text, status: "active"|"removed", paragraph_break, timestamp }
     */
    // this.segments = [];     // initialized in constructor
    // this._actions = {};     // registered action handlers

    /**
     * Register a custom action handler.
     * When the LLM detects the spoken phrase, the SDK emits 'action' and calls the handler.
     *
     * @param {string} id - Action id (must match the id registered server-side)
     * @param {Function} handler - Called with { action, phrase, segment_id }
     */
    registerAction(id, handler) {
        if (!this._actions) this._actions = {};
        this._actions[id] = handler;
    }

    /**
     * Get the current "settled" transcript — all active segments' cleaned text,
     * joined with appropriate spacing and paragraph breaks.
     *
     * @returns {string}
     */
    getTranscript() {
        if (!this.segments) return '';
        return this.segments
            .filter(s => s.status === 'active')
            .map(s => s.text)
            .join(s => s.paragraph_break ? '\n\n' : ' ');
    }

    /**
     * Handle an assistant event from the server.
     * Dispatches to the appropriate handler based on type.
     */
    _handleAssistantEvent(data) {
        if (!this.segments) this.segments = [];

        if (data.type === 'cleanup' || data.type === 'paragraph') {
            if (data.type === 'paragraph') {
                // Server measured a long pause — record it so the dictation handed
                // to "kimi stop/send" cleanup carries paragraph structure.
                this._kimiDictationText = (this._kimiDictationText.replace(/\s+$/, '') + '\n\n').trimStart();
            }
            // Pause-triggered cleanup + paragraph-break notice \u2014 no segment
            // bookkeeping, just relay to the page.
            this.emit('assistant', data);

        } else if (data.type === 'correction' || data.type === 'passthrough') {
            // Add a new segment with cleaned text
            const segment = {
                id: data.segment_id,
                raw: data.original,
                text: data.text,
                status: 'active',
                paragraph_break: false,
                timestamp: Date.now(),
            };
            this.segments.push(segment);
            this.emit('assistant', { ...data, segment });

        } else if (data.type === 'command') {
            // Built-in transcript manipulation commands
            const cmd = data.command;
            if (cmd === 'delete_last_sentence' || cmd === 'undo') {
                // Mark the last active segment as removed (non-destructive)
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        break;
                    }
                }
            } else if (cmd === 'delete_last_paragraph') {
                // Remove segments back to the last paragraph break
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        if (this.segments[i].paragraph_break) break;
                    }
                }
            } else if (cmd === 'paragraph_break') {
                // Mark the last active segment as ending a paragraph
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].paragraph_break = true;
                        break;
                    }
                }
            }
            this.emit('command', { command: cmd, original: data.original, segment_id: data.segment_id });

        } else if (data.type === 'action') {
            // Custom action — emit event and call registered handler
            const actionEvent = { action: data.action, original: data.original, segment_id: data.segment_id };
            this.emit('action', actionEvent);
            if (this._actions && this._actions[data.action]) {
                this._actions[data.action](actionEvent);
            }
        }
    }

    setAudioDevice(deviceId) {
        this.audioDeviceId = deviceId;
    }

    async enableWakeWord(modelUrl) {
        if (typeof ort === 'undefined') {
            throw new Error("onnxruntime-web is not loaded.");
        }

        this.emit('telemetry', { state: 'Loading ONNX model...', rtf: 0, backlog_sec: 0 });

        // ORT resolves WASM paths relative to the ort.js script URL.
        // Since ort.js is served from /sdk/ort.js, it will find /sdk/ort-wasm-*.wasm.
        // No need to set wasmPaths explicitly — just ensure the files are there.
        console.log('[VAD] ORT version:', ort.env.version || 'unknown');

        console.log('[VAD] Loading ONNX model from', modelUrl);

        // Match vad-web: fetch to ArrayBuffer first, then create session from buffer
        const modelResponse = await fetch(modelUrl);
        const modelBuffer = await modelResponse.arrayBuffer();
        console.log('[VAD] Model loaded, size=', modelBuffer.byteLength, 'bytes');
        this.wwSession = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        console.log('[VAD] ORT session created, inputs:', this.wwSession.inputNames, 'outputs:', this.wwSession.outputNames);

        // Silero V4 legacy: h/c [2, 1, 64] float32 zeros
        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        // Use BigInt constructor for broader compatibility (not literal syntax)
        this.wwSr = new ort.Tensor('int64', [BigInt(16000)], []);

        this.wakeWordEnabled = true;
        this.isAwake = false;

        this.emit('telemetry', { state: 'ONNX model loaded', rtf: 0, backlog_sec: 0 });
    }

    /**
     * Enable "ok kimi" wake mode via the worker-side acoustic detector.
     *
     * Instead of the browser running Silero VAD locally, the client streams the
     * raw 16kHz frames to the worker's /v1/wakeword/ws detector (which runs the
     * trained kimi_wake model). The worker emits {type:"wake"} when "ok kimi"
     * crosses threshold; the client then wakes and captures the next utterance.
     *
     * Must be called before start(). Disables local VAD wake (if any).
     */
    async enableKimiWakeWord() {
        this.kimiWakeEnabled = true;
        this.wakeWordEnabled = true;
        this.isAwake = false;
        this._finalReceived = false;
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiDictationText = '';
        this._kimiIdleCount = 0;
        this._kimiClassifying = false;
        this._kimiInterruptedTranscribing = false;
        this._kimiCommandTimer = null;

        const model = this.engine ? `?model=${encodeURIComponent(this.engine)}` : '';
        const { wsBase } = this._apiBase();
        this._kimiWs = new WebSocket(`${wsBase}/v1/wakeword/ws${model}${model ? '&' : '?'}telemetry=1`);

        this._kimiWs.onmessage = (event) => {
            let evt;
            try { evt = JSON.parse(event.data); } catch { return; }
            if (evt.type === 'wake') {
                console.log('[Kimi] wake detected, score=' + evt.score);
                this._onKimiWake();
            } else if (evt.type === 'score') {
                // throttled diagnostic so we can see live detector liveness
                this._kimiDiagCount = (this._kimiDiagCount || 0) + 1;
                if (this._kimiDiagCount % 30 === 0) {
                    console.log('[Kimi] score=' + evt.score);
                }
            }
        };
        this._kimiWs.onerror = (e) => {
            console.error('[Kimi] wake-word WS error', e);
            // Fall back to "always awake" so the loop isn't dead.
            if (!this.isAwake) { this.isAwake = true; this.emit('wakeWordDetected'); }
        };
        this._kimiWs.onclose = () => {
            console.log('[Kimi] wake-word WS closed');
            this._kimiWs = null;
        };

        console.log('[Kimi] kimi wake mode armed (worker detector)');
    }

    /**
     * Build an AudioWorklet that downsamples the mic to 16kHz mono float32
     * frames and forwards each frame to the realtime WebSocket. Gated by
     * isAwake — when asleep (wake-word mode), frames are produced but dropped,
     * so no audio leaves the browser until the wake word fires.
     */
    async _setupStreamingWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._streamContext = ctx;
        const nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 512; // 32ms @ 16kHz
        const source = ctx.createMediaStreamSource(this.audioStream);

        const workletCode = `
        class StreamProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
            }
            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }
            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0, inIdx = 0;
                while (outIdx < this.frameSize) {
                    let sum = 0, num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) { sum += val; num++; }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }
                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }
            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;
                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);
                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this.port.postMessage({ audio: frame.buffer }, [frame.buffer]);
                    }
                }
                return true;
            }
        }
        registerProcessor('stream-processor', StreamProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);

        this._streamNode = new AudioWorkletNode(ctx, 'stream-processor');
        this._preWakeBuffer = [];      // frames received while asleep
        this._preWakeMaxFrames = 10;   // ~320ms at 32ms/frame
        this._streamNode.port.onmessage = (event) => {
            const frame = event.data.audio;  // ArrayBuffer of float32 16kHz

            // Kimi wake mode: the wake-word detector (worker) needs ALL audio,
            // asleep or awake — it decides when "ok kimi" was spoken.
            if (this.kimiWakeEnabled && this._kimiWs && this._kimiWs.readyState === WebSocket.OPEN) {
                try { this._kimiWs.send(frame); } catch (e) { /* ignore */ }
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.isAwake) {
                // Asleep: buffer frame for retroactive send on wake.
                // This prevents the first word from being clipped by the
                // wake detection delay.
                this._preWakeBuffer.push(frame);
                if (this._preWakeBuffer.length > this._preWakeMaxFrames) {
                    this._preWakeBuffer.shift();
                }
                return;
            }
            this.ws.send(frame);                             // ArrayBuffer of float32
        };

        source.connect(this._streamNode);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this._streamNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _setupAudioWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        let ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.audioContext = ctx;

        // A context can be born CLOSED when the tab has exhausted the browser's
        // AudioContext quota (~6). Every subsequent call on it fails with a cryptic
        // InvalidStateError ("No execution context available") — name the real
        // cause instead, with the remedy that actually works.
        if (ctx.state === 'closed') {
            const err = new Error('AudioContext born closed — browser audio-context quota exhausted by leaked contexts. Reload the page.');
            this.audioContext = null;
            try { ctx.close(); } catch { /* already closed */ }
            throw err;
        }

        // iOS Safari: AudioContext starts suspended, must be resumed after user gesture
        if (ctx.state === 'suspended') {
            console.log('[VAD] AudioContext suspended, resuming...');
            try {
                await ctx.resume();
            } catch (e) {
                console.warn('[VAD] Could not resume AudioContext:', e);
            }
        }

        let nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 1536;

        let source = ctx.createMediaStreamSource(this.audioStream);

        // Exact vad-web resampler algorithm ported into AudioWorklet
        const workletCode = `
        class VADProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
                this._fc = 0;
            }

            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }

            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0;
                let inIdx = 0;

                while (outIdx < this.frameSize) {
                    let sum = 0;
                    let num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) {
                            sum += val;
                            num++;
                        }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }

                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }

            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;

                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);

                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this._fc++;
                        this.port.postMessage({ audio: frame.buffer, fc: this._fc }, [frame.buffer]);
                    }
                }

                return true;
            }
        }
        registerProcessor('vad-processor', VADProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);

        // A context can die BETWEEN birth and node construction (the addModule
        // await is a window; a busy renderer can also refuse the worklet
        // thread). Both surface as InvalidStateError "No execution context
        // available". Retry ONCE with a fresh context before giving up — the
        // common case is a stale context, and a new one is cheap.
        let node = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await ctx.audioWorklet.addModule(workletUrl);
                if (ctx.state === 'closed') throw new Error('context closed during addModule');
                node = new AudioWorkletNode(ctx, 'vad-processor');
                break;
            } catch (e) {
                if (attempt === 2 || ctx.state !== 'closed' && !(e instanceof InvalidStateError)) {
                    const err = new Error(`AudioWorklet setup failed: ${e.message}. If it persists, reload the page — the renderer may be out of audio contexts.`);
                    this.audioContext = null;
                    try { ctx.close(); } catch { /* already closed */ }
                    throw err;
                }
                console.warn('[VAD] context unusable, retrying with a fresh one:', e.message);
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                this.audioContext = ctx;
                if (ctx.state === 'closed') {
                    this.audioContext = null;
                    throw new Error('AudioContext born closed — browser audio-context quota exhausted by leaked contexts. Reload the page.');
                }
                if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* gesture policies */ } }
                // The stream source belongs to the OLD context — recreate it on
                // the new one or no audio ever reaches the worklet (silent deaf).
                nativeSr = ctx.sampleRate;
                source = ctx.createMediaStreamSource(this.audioStream);
            }
        }
        this.workletNode = node;
        console.log('[VAD] AudioWorklet registered. nativeSr=' + nativeSr + ' targetSr=' + targetSr + ' frameSize=' + frameSize);

        this.workletNode.port.onmessage = (event) => {
            const audio = new Float32Array(event.data.audio);
            this._vadChain = this._vadChain.then(() => this._processVAD(audio, event.data.fc)).catch(console.error);
        };

        source.connect(this.workletNode);

        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _processVAD(audioFrame, fc) {
        if (!this.wakeWordEnabled || !this.wwSession) return;
        if (this.kimiWakeEnabled) return;  // kimi mode: wake decided by worker detector

        try {
            const inputTensor = new ort.Tensor('float32', audioFrame, [1, audioFrame.length]);

            const feeds = {
                input: inputTensor,
                h: this.wwH,
                c: this.wwC,
                sr: this.wwSr
            };

            const results = await this.wwSession.run(feeds);

            this.wwH = results.hn;
            this.wwC = results.cn;

            const prob = results.output.data[0];

            // Throttled diagnostic: log VAD liveness + prob every ~3s so we can
            // tell "VAD dead" apart from "VAD alive but prob never crosses threshold".
            this._vadDiagCount = (this._vadDiagCount || 0) + 1;
            if (this._vadDiagCount % 32 === 0) {
                console.log(`[VAD] alive=${this.isAwake ? 'awake' : 'asleep'} prob=${prob.toFixed(3)} fc=${fc}`);
            }

            if (!this.isAwake) {
                // ASLEEP: require SUSTAINED speech to wake. A single frame above
                // threshold is too easy to trip on amplified fan/ambient noise
                // (AGC-free mics still push broadband noise over 0.5 on isolated
                // frames). Speech sustains high prob across consecutive frames;
                // noise is spiky. 3 frames ≈ 96ms of sustained speech — responsive
                // to voice, immune to transient noise.
                if (prob > this._wakeThreshold) {
                    this._wakeCount = (this._wakeCount || 0) + 1;
                    if (this._wakeCount >= this._wakeFrames) {
                        console.log('[VAD] WAKE (sustained prob=' + prob.toFixed(3) + ', frames=' + this._wakeCount + ')');
                        this.wake();
                    }
                } else {
                    this._wakeCount = 0;
                }
            } else {
                // AWAKE: hang up on sustained non-speech (endpointing).
                // Design per industry VAD/turn-stop research (Pipecat et al.):
                // the countdown resets ONLY on CONFIDENT speech (prob >= wake
                // threshold), NOT on the mid-prob decay tail of a noise burst.
                // A scrape peaks ~0.5s then decays 0.47→0.04 — only that brief
                // peak counts as speech; the whole decay tail counts toward hang-up.
                // A real conversational pause ends with confident resumed speech,
                // which resets the timer. ~20 frames × 96ms ≈ 2s (research's
                // 1.5–3.0s guidance for dictation pause tolerance).
                if (prob >= this._hangupResetProb) {
                    this._hangupCount = 0;
                } else {
                    this._hangupCount = (this._hangupCount || 0) + 1;
                    if (this._hangupCount >= this._hangupFrames) {
                        console.log('[VAD] HANG-UP (sustained non-speech, frames=' + this._hangupCount + ')');
                        this.sleep();
                    }
                }
            }
            // Note: endpointing (sentence-final commit) is the BACKEND strategy's
            // job (commit_silence_tail_sec). This browser hang-up only decides when
            // to STOP SENDING audio so the backend goes idle. Two separate concerns.
        } catch (e) {
            console.error('[VAD] Inference error:', e);
        }
    }

    wake() {
        if (!this.wakeWordEnabled || this.isAwake) return;

        this.isAwake = true;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._hangupCount = 0;   // fresh endpointing window on wake

        // Flush pre-wake buffer: send the last ~320ms of audio that was
        // captured during the wake detection delay. This recovers the
        // first word that would otherwise be clipped.
        if (this._preWakeBuffer && this._preWakeBuffer.length > 0) {
            console.log('[VAD] Flushing pre-wake buffer:', this._preWakeBuffer.length, 'frames');
            for (const frame of this._preWakeBuffer) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(frame);
                }
            }
            this._preWakeBuffer = [];
        }

        this.emit('wakeWordDetected');
    }

    sleep() {
        if (!this.wakeWordEnabled || !this.isAwake) return;

        this.isAwake = false;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._wakeCount = 0;   // reset sustained-wake counter for next listen cycle
        this._hangupCount = 0; // reset endpointing counter

        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);

        // Frames stop flowing to the WebSocket while asleep.
        this.emit('asleep');
    }

    // --- Kimi state machine (Phase 4) --------------------------------------
    // States: sleep → command → transcribing (loop back to sleep or command).
    //   sleep        : listening for "ok kimi". On wake → command.
    //   command      : capturing the next utterance to classify (listen/stop/
    //                  send/other). On final + idle → classify → dispatch.
    //   transcribing : continuous dictation. On "ok kimi" (interrupt) → command
    //                  to capture stop/send.
    //
    // Events emitted to the host app:
    //   kimiState    {state}                     — sleep|command|transcribing
    //   kimiCommand  {action, text}              — a classified command action
    //   kimiDictation {text}                     — accumulated dictation text
    //   assistantState {state}                   — R3: listening|capturing|processing
    //   assistantMessage {raw, text}             — R3: one deliverable per capture
    //   assistantCancel {reason}                 — R3: capture discarded
    //   assistantError {error, raw}              — R3: cleanup failed (raw still delivered)

    _onKimiWake() {
        // R3 assistant mode: wake from listening goes STRAIGHT to capturing —
        // no "listen" gate (autoListen). A wake during capture falls through
        // to the interrupt path below (end/cancel command capture).
        if (this.assistantMode && this._kimiState === 'sleep' && this._assistantAutoListen) {
            console.log('[Assistant] wake → capturing');
            this._assistantStartCapture();
            return;
        }
        // "ok kimi" heard. From sleep → capture a command; from transcribing →
        // interrupt to capture a stop/send command. Already capturing a command?
        // Ignore (don't double-capture).
        if (this._kimiState === 'command') return;
        const wasTranscribing = this._kimiState === 'transcribing';
        this._kimiState = 'command';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        this._kimiInterruptedTranscribing = wasTranscribing;
        if (!this.isAwake) {
            this.wake();
        }
        console.log('[Kimi] -> command' + (wasTranscribing ? ' (interrupting transcription)' : ''));
        this.emit('kimiState', { state: 'command' });
        this._armKimiCommandTimeout();
    }

    /**
     * Called from the STT transcript handler when a final transcript lands.
     * Routes the text depending on kimi state:
     *   command      → accumulate as the command utterance
     *   transcribing → accumulate as dictation
     */
    _kimiOnFinal(text) {
        // Returns true when the final was consumed as a COMMAND utterance (it
        // must then be suppressed from the transcript — control words are not
        // dictation). Returns false for dictation/ignored finals.
        if (this._kimiState === 'command') {
            this._kimiCommandText = (this._kimiCommandText + ' ' + text).trim();
            this._kimiCommandFinal = true;
            this._kimiIdleCount = 0;
            this.emit('kimiCommandText', { text: this._kimiCommandText });
            // NOTE: the command timeout stays armed as a safety net — if idle
            // telemetry never arrives (so classify never fires), the timeout
            // force-classifies or restores the dictation instead of wedging the
            // client in command state.
            return true;
        }
        // R3: wake-word residue suppression at capture start (see below).
        // NOTE: bare end commands ("stop" with no "ok kimi") are NOT honored in
        // assistant mode — short content utterances ("...eventually say stop")
        // are indistinguishable from commands. End commands are wake-gated:
        // "ok kimi send" / "ok kimi stop" / "ok kimi cancel" only.
        if (this.assistantMode && this._kimiState === 'transcribing') {
            if (this._assistantIsWakeResidue(text)) {
                console.log('[Assistant] wake residue suppressed: "' + text + '"');
                return true;  // consumed, not dictation
            }
        }
        // Acoustic wake missed — the STT still transcribed the command phrase, so
        // recognize it from text ("ok kimi listen/send/stop", or a bare short
        // command). This is what makes the flow work when the wake detector
        // fails to fire on the live voice ("3 attempts" symptom).
        if (this.assistantMode) {
            // Assistant mode: the wake token alone ("okay kimi", ≤3 words) opens
            // a command window — the actual command word typically arrives as
            // the NEXT final after a pause. Complete commands ("ok kimi send")
            // fall through to the normal text-command path below.
            const normOnly = _kimiNormalize(text);
            const wakeOnly = /\b(kimi|kimmy|kyumi)\b/.test(normOnly)
                && normOnly.split(' ').filter(Boolean).length <= 3
                && !/\b(send|sende|stop|stopp|halt|listen|cancel|abort|abbrechen|forget|never)\b/.test(normOnly);
            if (wakeOnly && this._kimiState === 'sleep') {
                console.log('[Kimi] text-wake (command word pending): "' + text + '"');
                this._kimiState = 'command';
                this._kimiCommandText = '';
                this._kimiCommandFinal = false;
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'command' });
                this._armKimiCommandTimeout();
                return true;
            }
        }
        if (this._kimiShouldTreatAsCommand(text)) {
            const wasTranscribing = this._kimiState === 'transcribing';
            this._kimiState = 'command';
            this._kimiCommandText = text;
            this._kimiCommandFinal = true;
            this._kimiIdleCount = 0;
            this._kimiInterruptedTranscribing = wasTranscribing;
            console.log('[Kimi] text-command (wake missed): "' + text + '"');
            this.emit('kimiState', { state: 'command' });
            this.emit('kimiCommandText', { text });
            this._armKimiCommandTimeout();  // safety net if telemetry never arrives
            return true;
        }
        if (this._kimiState === 'transcribing') {
            this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim();
            this._kimiIdleCount = 0;
            this.emit('kimiDictation', { text: this._kimiDictationText });
            return false;
        }
        // Assistant mode: 'sleep' (= listening) is QUIET. The mic stays open
        // (the wake detector needs the stream), but speech between commands
        // is neither emitted nor accumulated — capture starts on "listen".
        // The wake-missed text fallback above still runs first, so a spoken
        // "ok kimi listen" lands even without an acoustic wake.
        if (this.assistantMode && this._kimiState === 'sleep') {
            return true;  // consumed — not transcript, not raw buffer
        }
        return false;
    }

    // ── RETIRED 2026-09-20: Assistant mode (kimi listen/hold/send wrapper) ──
    // The reactive assistant (intentEnabled / ?intent=1) replaced it: turn
    // detection by the server-side gauntlet, replies via the reply events,
    // cleanup on the verdict call. enableKimiWakeWord() remains available as a
    // plain wake gate for dictation. Kept as a loud error rather than deleted
    // so old integrations fail with instructions instead of TypeError.
    async enableAssistantMode() {
        throw new Error('enableAssistantMode is retired — use the reactive assistant: client.intentEnabled = true (see sdk/README.md "Reactive assistant"). Wake-gated dictation: enableKimiWakeWord().');
    }

    /** No-op retained for old integrations (mode can no longer be enabled). */
    disableAssistantMode() {}

    _assistantMatchPhrase(text, phrases) {
        const norm = _kimiNormalize(text);
        if (!norm) return false;
        return phrases.some((p) => {
            const np = _kimiNormalize(p);
            return np && new RegExp('(^|\\s)' + np.replace(/\s+/g, '\\s+') + '(\\s|$)').test(norm);
        });
    }

    _assistantStartCapture() {
        this._kimiState = 'transcribing';
        this._kimiDictationText = '';
        this._kimiIdleCount = 0;
        this._kimiInterruptedTranscribing = false;
        if (!this.isAwake) this.wake();
        // Wake fires MID-phrase: the tail of "ok kimi" can land as the first
        // dictation final ("Me.", "kimi"). Suppress a short wake-ish final
        // arriving right after capture opens (see _kimiOnFinal).
        this._assistantCaptureAt = Date.now();
        this.emit('assistantState', { state: 'capturing' });
        this.emit('kimiState', { state: 'transcribing' });
    }

    // Is this final wake-word residue? Only plausible in the first second of a
    // capture, only if short, only if it reads like the wake phrase tail.
    _assistantIsWakeResidue(text) {
        if (!this._assistantCaptureAt) return false;
        if (Date.now() - this._assistantCaptureAt > 1000) return false;
        const norm = _kimiNormalize(text);
        const words = norm.split(' ').filter(Boolean);
        if (words.length > 2) return false;
        return words.every((w) => /^(ok|okay|kimi|kimmy|kyumi|me|hey|hi|ja|yes)$/.test(w));
    }

    async _assistantEnd(action) {
        const raw = (this._kimiDictationText || '').trim();
        if (action === 'send' && !raw && !this._assistantHeldText) {
            // nothing to send at all
            this._kimiState = 'sleep';
            this.emit('assistantCancel', { reason: 'empty' });
            this.emit('assistantState', { state: this._assistantHeldText ? 'held' : 'listening' });
            return;
        }
        if (action === 'stop') {
            // HOLD: keep the text, send nothing. "ok kimi stop" = wait, don't
            // send yet. From held, "ok kimi send" delivers it.
            this._kimiState = 'sleep';
            this._kimiInterruptedTranscribing = false;
            this._clearKimiCommandTimeout();
            if (raw) this._assistantHeldText = raw;
            this._kimiDictationText = '';
            this.emit('assistantHold', { text: this._assistantHeldText });
            this.emit('assistantState', { state: 'held' });
            this.emit('kimiState', { state: 'sleep' });
            return;
        }
        if (action === 'cancel') {
            this._kimiState = 'sleep';
            this._kimiInterruptedTranscribing = false;
            this._clearKimiCommandTimeout();
            this._kimiDictationText = '';
            this._assistantHeldText = null;   // cancel discards held text too
            this.emit('assistantCancel', { reason: 'cancel' });
            this.emit('assistantState', { state: 'listening' });
            this.emit('kimiState', { state: 'sleep' });
            return;
        }
        // 'send': deliver current capture, or the held text if capture is empty
        const toSend = raw || this._assistantHeldText;
        this._kimiState = 'sleep';
        this._kimiInterruptedTranscribing = false;
        this._clearKimiCommandTimeout();
        this._kimiDictationText = '';
        this._assistantHeldText = null;
        this.emit('assistantState', { state: 'processing' });
        let text = toSend;
        if (this._assistantCleanupMode !== false) {
            try {
                text = await this.cleanup(toSend, this._assistantCleanupMode);
            } catch (err) {
                // Fail-loud but still deliver: the app shows the error and gets raw.
                this.emit('assistantError', { error: err.message, raw: toSend });
                text = toSend;
            }
        }
        this.emit('assistantMessage', { raw: toSend, text });
        this.emit('assistantState', { state: 'listening' });
        this.emit('kimiState', { state: 'sleep' });
    }

    // A final that wasn't captured in `command` state (acoustic wake missed) can
    // still be a command. Heuristic: it matches a command word AND is either a
    // bare short command (<= 2 words, e.g. "send", "и сен") or carries a wake
    // token ("kimi"/"kimmy"/"кюми"). Longer dictation like "i listen to music"
    // or "eventually i will stop it" is left as dictation.
    // ASSISTANT MODE: bare commands are disabled — the wake token is REQUIRED,
    // because short content ("...say stop" landing as its own final) would
    // otherwise end the capture.
    _kimiShouldTreatAsCommand(text) {
        if (!_kimiMatchCommand(text)) return false;
        const norm = _kimiNormalize(text);
        const words = norm.split(' ').filter(Boolean).length;
        if (this.assistantMode) {
            return /\b(kimi|kimmy|kyumi)\b/.test(norm);  // wake token required
        }
        if (words === 1) return true;  // bare single-word command ("stop", "listen")
        return /\b(kimi|kimmy|kyumi)\b/.test(norm);  // carries a wake token
    }

    _clearKimiCommandTimeout() {
        if (this._kimiCommandTimer) { clearTimeout(this._kimiCommandTimer); this._kimiCommandTimer = null; }
    }

    _armKimiCommandTimeout() {
        this._clearKimiCommandTimeout();
        this._kimiCommandTimer = setTimeout(() => {
            this._kimiCommandTimer = null;
            if (this._kimiState !== 'command') return;
            // A final was captured but classify never fired (no idle telemetry) —
            // force-classify now so a command isn't stuck and the flow continues.
            if (this._kimiCommandFinal) { this._kimiClassifyCommand(); return; }
            if (this._kimiInterruptedTranscribing) {
                // False wake with no command captured — resume transcribing and
                // re-surface any text swallowed into the command capture so it
                // does NOT vanish from the transcript panel.
                const t = (this._kimiCommandText || '').trim();
                if (t) {
                    this._kimiDictationText = (this._kimiDictationText + ' ' + t).trim();
                    this.emit('kimiDictation', { text: this._kimiDictationText });
                    this.emit('transcript', { type: 'transcript', text: t + ' ', is_final: true });
                }
                this._kimiState = 'transcribing';
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'transcribing' });
                if (this.assistantMode) this.emit('assistantState', { state: 'capturing' });
            } else {
                this._kimiToSleep('command timeout');
            }
        }, 4000);
    }

    /**
     * Telemetry-driven state progression. In `command` state, after the first
     * final lands and the backend reports idle/silence (utterance fully
     * committed), classify the command and dispatch. In `transcribing` state
     * idle/silence is ignored (dictation continues until interrupted).
     */
    _kimiHandleTelemetry(data) {
        if (!this.kimiWakeEnabled || !this.isAwake) return;

        if (this._kimiState === 'command') {
            if (this._kimiCommandFinal && data.state === 'idle/silence') {
                this._kimiIdleCount = (this._kimiIdleCount || 0) + 1;
                if (this._kimiIdleCount >= this._kimiIdleToClassify) {
                    this._kimiClassifyCommand();
                }
            }
        }
    }

    /**
     * Match the captured command LOCALLY (no gateway) and dispatch.
     */
    async _kimiClassifyCommand() {
        if (this._kimiState !== 'command' || this._kimiClassifying) return;
        this._kimiClassifying = true;
        try {
            const text = this._kimiCommandText.trim();
            if (!text) { this._kimiToSleep('no command captured'); return; }

            console.log('[Kimi] classifying command: "' + text + '"');
            const action = _kimiMatchCommand(text);  // 'listen' | 'stop' | 'send' | null
            console.log('[Kimi] command action=' + (action || 'none') +
                        (this._kimiInterruptedTranscribing ? ' (interrupted transcription)' : ''));

            // R3 assistant mode: cancel vocabulary ends the capture discarded.
            // Checked BEFORE the false-wake restore — a cancel word after wake
            // is deliberate, not dictation.
            if (this.assistantMode && this._assistantMatchPhrase(text, this._assistantCancelPhrases)) {
                this._assistantEnd('cancel');
                return;
            }

            // A wake that interrupted transcription is only honored for real
            // commands. No match = false wake (it was dictation) → resume
            // transcribing, don't respond, don't lose the dictation.
            if (action === null && this._kimiInterruptedTranscribing) {
                // Put the captured text back into the dictation (it wasn't a command)
                // AND re-surface it in the raw transcript — a false wake must NOT
                // make dictation vanish from the panel.
                if (text) {
                    this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim();
                    this.emit('kimiDictation', { text: this._kimiDictationText });
                    this.emit('transcript', { type: 'transcript', text: text + ' ', is_final: true });
                    console.log('[Kimi] false wake — dictation restored: "' + text + '"');
                }
                this._kimiState = 'transcribing';
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'transcribing' });
                if (this.assistantMode) this.emit('assistantState', { state: 'capturing' });
                return;
            }

            // Not a command and nothing was being dictated — silently return to
            // sleep. No gateway call, no response.
            if (action === null) { this._kimiToSleep('not a command'); return; }

            switch (action) {
                case 'listen':
                    if (this.assistantMode) {
                        // Fresh capture cycle. Any HELD text is discarded — the
                        // user chose to start over instead of sending it.
                        this._assistantHeldText = null;
                        this._assistantStartCapture();
                        break;
                    }
                    this._kimiState = 'transcribing';
                    this._kimiIdleCount = 0;
                    this._kimiInterruptedTranscribing = false;
                    // Fresh dictation cycle — clear the previous session's
                    // accumulated text and tell the server to reset its
                    // segmented-cleanup state, so the new transcript starts
                    // clean instead of appending to the last one.
                    this._kimiDictationText = '';
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'assistant_reset' }));
                    }
                    this.emit('kimiState', { state: 'transcribing' });
                    this.emit('kimiCommand', { action: 'listen', text });
                    break;
                case 'stop':
                    if (this.assistantMode) {
                        // "ok kimi stop": HOLD the capture — nothing is sent.
                        this._assistantEnd('stop');
                        break;
                    }
                    // Stop transcribing. The dictation is KEPT and handed to the
                    // page for LLM cleanup ("ok kimi stop" flow) — not discarded.
                    this._kimiState = 'sleep';
                    this._kimiInterruptedTranscribing = false;
                    this.emit('kimiCommand', { action: 'stop', text, dictation: this._kimiDictationText });
                    this.sleep();
                    break;
                case 'send':
                    if (this.assistantMode) {
                        // "ok kimi send": deliver current capture (or held text).
                        this._assistantEnd('send');
                        break;
                    }
                    this._kimiState = 'sleep';
                    this._kimiInterruptedTranscribing = false;
                    this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText });
                    this.sleep();
                    break;
            }
        } finally {
            this._kimiClassifying = false;
            this._clearKimiCommandTimeout();
        }
    }

    _kimiToSleep(reason) {
        console.log('[Kimi] -> sleep (' + reason + ')');
        this._clearKimiCommandTimeout();
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        this.emit('kimiState', { state: 'sleep' });
        // Assistant mode: unsent held text survives; the visible state is
        // 'held', not 'listening'.
        if (this.assistantMode) {
            this.emit('assistantState', { state: this._assistantHeldText ? 'held' : 'listening' });
        }
        // Keep the mic open — do NOT call this.sleep(). The keep-awake
        // policy says once awake, stay awake. If the STT final arrives
        // late (after timeout), _kimiOnFinal's text-command fallback
        // will still pick up "ok kimi listen" and re-enter the loop
        // instead of the user having to repeat themselves.
    }

    async start() {
        // Guard against overlapping/duplicate start() calls. A second concurrent
        // start races on the shared AudioContext fields, leaving the worklet
        // unregistered ("vad-processor is not defined") and the UI stuck.
        if (this._starting) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        this._starting = true;
        try {
            console.log('[nVoice] start() called, wakeWordEnabled=' + this.wakeWordEnabled);

            // Audio constraints: phones need AGC/noiseSuppression because the mic
            // is far from the mouth. Desktop with a good mic benefits from raw audio.
            // User can override with the "Raw Audio" toggle.
            const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
            // AEC/NS/AGC. Two paths need it: assistant mode and turn-taking, both
            // of which speak a reply with the mic still open. Without cancellation
            // the mic picks up the assistant, the echo reads as the user speaking,
            // and it cuts its own playback — or starts replying to itself.
            // Decided here, where the constraints are built: consumers set
            // intentEnabled as a property after construction at least as often as
            // they pass it in config, so a constructor-time check silently misses.
            const openMicAssistant = this.audioProcessing || this.intentEnabled;
            const useProcessing = openMicAssistant || (this.rawAudio ? false : isMobile);
            // AEC-only for open-mic assistant sessions. AEC is mandatory (the
            // mic must not hear the reply), but bundling NS+AGC along — the old
            // behavior — lifts the noise floor until the VAD reads breathing as
            // speech, and NS is tuned for far-end calls, not ASR feed. Explicit
            // per-flag overrides still win.
            const dsp = (own, def) => (own === undefined ? def : !!own);
            const assistantDsp = (flag) => (openMicAssistant ? flag : useProcessing);

            const constraints = {
                audio: {
                    echoCancellation: dsp(this.echoCancellation, assistantDsp(true)),
                    noiseSuppression: dsp(this.noiseSuppression, assistantDsp(false)),
                    autoGainControl: dsp(this.autoGainControl, assistantDsp(false)),
                }
            };

            console.log('[nVoice] Audio constraints:', JSON.stringify(constraints.audio), '(mobile=' + isMobile + ', rawOverride=' + !!this.rawAudio + ')');

            if (this.audioDeviceId && this.audioDeviceId !== 'default') {
                constraints.audio.deviceId = { exact: this.audioDeviceId };
            }

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);

            if (this.wakeWordEnabled) {
                this.isAwake = false;
                this._finalReceived = false;
                this._silenceCount = 0;
                if (this.kimiWakeEnabled) {
                    // Kimi mode: no local Silero VAD — the worker detector drives
                    // wake. The stream worklet (set up below after the session)
                    // routes frames to /v1/wakeword/ws.
                } else {
                    this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    await this._setupAudioWorklet();
                }
            } else {
                this.isAwake = true;
            }

            // Local engines: realtime audio over WebSocket (browser → Node → worker).
            // Cloud engines: handled separately via their own WebSocket flow below.
            console.log('[nVoice] Creating realtime session... (engine=' + (this.engine || 'default') + ')');
            const { httpBase } = this._apiBase();
            const sessionUrl = this.engine
                ? `${httpBase}/v1/realtime/sessions?model=${encodeURIComponent(this.engine)}`
                : `${httpBase}/v1/realtime/sessions`;
            const sessionResp = await fetch(sessionUrl);
            if (!sessionResp.ok) {
                throw new Error('Failed to create realtime session: ' + sessionResp.status);
            }
            const session = await sessionResp.json();
            this._sessionId = session.id;
            console.log('[nVoice] Session created: ' + session.id);

            // Cloud engines use WebSocket directly to the provider — no local worker
            if (session.cloud) {
                console.log('[nVoice] Cloud engine detected (' + session.provider + '), using WebSocket flow');
                await this._startCloudRealtime(session, this.audioStream);
                return;
            }

            // Build the streaming worklet that feeds PCM frames to the socket.
            await this._setupStreamingWorklet();

            // Open the realtime WebSocket (ws on http, wss on https).
            // recordDebug → worker captures engine-received audio to a WAV (output/).
            const { wsBase } = this._apiBase();
            let wsUrl = `${wsBase}${session.ws_endpoint}`;
            if (this.recordDebug) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'record=1';
            }
            if (this.assistantEnabled) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'assistant=1';
            }
            if (this.intentEnabled) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'intent=1';
                if (this.intentReplyModel) {
                    wsUrl += `&reply_model=${encodeURIComponent(this.intentReplyModel)}`;
                }
                if (this.intentPauseMs) {
                    wsUrl += `&pause_ms=${encodeURIComponent(this.intentPauseMs)}`;
                }
                if (this.intentMaxSilenceMs) {
                    wsUrl += `&max_silence_ms=${encodeURIComponent(this.intentMaxSilenceMs)}`;
                }
                if (this.intentNoReply) {
                    wsUrl += '&noreply=1';
                }
                if (this.intentMaxTokens) {
                    wsUrl += `&max_tokens=${encodeURIComponent(this.intentMaxTokens)}`;
                }
            }
            if (this.intentEnabled) {
                this._trace = _turnTraceNew({
                    engine: this.engine || '(server default)',
                    audioDevice: this.audioDeviceId || '(default)',
                    pauseMs: this.intentPauseMs ?? null,
                    maxSilenceMs: this.intentMaxSilenceMs ?? null,
                    generateReply: !this.intentNoReply,
                });
                this._turnSig = null;
                this.turn = null;
                this.lastReport = null;
                this.lastReportText = null;
            }
            console.log('[nVoice] Connecting realtime WebSocket: ' + wsUrl);
            this.ws = new WebSocket(wsUrl);
            this._connectTimer = setTimeout(() => {
                if (!this.ws || this.ws.readyState === WebSocket.OPEN) return;
                this.emit('error', new Error(`realtime connect timed out after ${this.connectTimeoutMs}ms (engine may still be loading)`));
                try { this.ws.close(); } catch { /* already closing */ }
            }, this.connectTimeoutMs);

            this.ws.onopen = () => {
                console.log('[nVoice] Realtime WebSocket open');
                this._disconnected = false;
                this._clearConnectTimer();
                _turnLog(this._trace, 'ws connected');
                // The socket is connected regardless of wake/sleep state.
                // Emit 'connected' (enables Stop), then signal asleep if wake-word is armed.
                this.emit('connected');
                if (this.wakeWordEnabled && !this.isAwake) {
                    this.emit('asleep');
                }
            };

            this.ws.onmessage = async (event) => {
                // Accept both text and binary frames. The Node relay may send
                // JSON as either depending on the ws library's frame type detection.
                let text;
                if (typeof event.data === 'string') {
                    text = event.data;
                } else if (event.data instanceof Blob) {
                    text = await event.data.text();
                } else if (event.data instanceof ArrayBuffer) {
                    text = new TextDecoder().decode(event.data);
                } else {
                    return;
                }
                try {
                    const data = JSON.parse(text);
                    if (data.type === 'transcript') {
                        if (this.wakeWordEnabled && data.is_final) {
                            this._finalReceived = true;
                        }
                        // Route finals into the kimi state machine (command capture
                        // or dictation accumulation). Command utterances are CONTROL
                        // words ("ok kimi listen/stop/send") — they must NOT appear
                        // in the transcript. Emit an empty final reset so consumers
                        // clear any lingering provisional tail.
                        if (this.kimiWakeEnabled && data.is_final && data.text) {
                            const consumedAsCommand = this._kimiOnFinal(data.text);
                            if (consumedAsCommand) {
                                this.emit('transcript', { type: 'transcript', text: '', is_final: true, is_command: true });
                                return;
                            }
                        }
                        // R2: accumulate every non-command final into the raw buffer
                        if (data.is_final && data.text && data.text.trim()) {
                            this._rawFinals = (this._rawFinals + ' ' + data.text.trim()).trim();
                        }
                        // Turn record: finals delimit turns (empty ones included — a
                        // silent final is itself a finding).
                        if (this._trace && data.is_final) {
                            _turnRecordFinal(this._trace, data.text);
                            this._syncTurn();
                        }
                        // An explicit interrupt word is evidence, not a guess, so it
                        // cuts immediately instead of waiting out the sustain window.
                        if (data.is_final && data.text && _BARGE_IN_RE.test(data.text)) {
                            this._fireBargeIn(0, 'keyword');
                        }
                        // Suppress provisionals while a REAL command is being captured
                        // (a wake from sleep). A false-wake interrupt is still
                        // dictation, so its provisionals stay visible.
                        // Assistant mode: also quiet in 'sleep' (listening) —
                        // nothing previews until "listen" starts the capture.
                        const quietState = (this._kimiState === 'command' && !this._kimiInterruptedTranscribing)
                            || (this.assistantMode && this._kimiState === 'sleep');
                        if (this.kimiWakeEnabled && !data.is_final && quietState) {
                            return;
                        }
                        this.emit('transcript', data);
                    } else if (data.type === 'assistant') {
                        this._handleAssistantEvent(data.result || data);
                    } else if (data.type === 'intent') {
                        if (this._trace) {
                            _turnRecordIntent(this._trace, data, data.latency_ms || 0);
                            this._syncTurn();
                        }
                        this.emit('intent', data);
                    } else if (data.type === 'verdict') {
                        if (this._trace) {
                            _turnRecordVerdict(this._trace, data);
                            this._syncTurn();
                        }
                        this.emit('verdict', data);
                    } else if (data.type === 'echo-suppressed') {
                        // The relay dropped a final that matched the spoken TTS
                        // output — self-echo the AEC failed to cancel. Recorded
                        // as a finding: heavy suppression means the acoustic
                        // path is degraded (music, mis-converged filter).
                        if (this._trace) {
                            const t = this._trace.open || this._trace.turns[this._trace.turns.length - 1];
                            _turnFind(this._trace, 'echo-suppressed', `final matched spoken TTS output — suppressed: "${(data.text || '').slice(0, 60)}"`, 'info', t ? t.index : null);
                            _turnLog(this._trace, `echo suppressed "${(data.text || '').slice(0, 60)}"`);
                        }
                        this.emit('echo-suppressed', data);
                    } else if (data.type === 'phase') {
                        if (this._trace) {
                            const rec = _turnRecordPhase(this._trace, data);
                            this._syncTurn();
                            if (rec.closed) this.emit('turn-end', _turnSnapshot(rec.closed, _turnState(rec.closed)));
                        }
                        this.emit('phase', data);
                    } else if (data.type === 'reply') {
                        if (this._trace) {
                            _turnRecordReply(this._trace, data.result || data);
                        }
                        this.emit('reply', data);
                    } else if (data.type === 'telemetry') {
                        // Track the user's VAD state and announce the silence → speech
                        // edge. This is the hook an app needs to cut assistant TTS
                        // playback, which outlives the server's generation window.
                        const speaking = data.state !== 'idle/silence';
                        if (speaking && !this.speaking) {
                            this.speaking = true;
                            this._speechStartedAt = Date.now();
                            this._bargeInFired = false;
                            this._ducked = false;
                            this.emit('speech-start');
                        } else if (!speaking && this.speaking) {
                            this.speaking = false;
                            this._speechStartedAt = null;
                            this.emit('speech-end');
                        }
                        // v2: sustained voiced audio during output DUCKS the TTS,
                        // it never hard-stops it. Only an interrupt keyword
                        // ('barge-in', keyword path) or a gauntlet-surviving new
                        // input (server COMPLETE → interrupted/new-input) may stop
                        // playback. Voiced seconds come from telemetry speech_sec
                        // (integrated once per sample server-side); wall clock is
                        // the fallback only.
                        if (speaking && !this._ducked && this._speechStartedAt) {
                            const voicedMs = Number.isFinite(data.speech_sec)
                                ? data.speech_sec * 1000
                                : Date.now() - this._speechStartedAt;
                            if (voicedMs >= this.duckMs) {
                                this._ducked = true;
                                this.emit('duck', { voicedMs });
                            }
                        }
                        this.emit('telemetry', data);
                        this._kimiHandleTelemetry(data);
                    }
                } catch (e) {
                    this.emit('error', new Error('Failed to parse realtime message: ' + e.message));
                }
            };

            this.ws.onerror = (err) => {
                console.error('[nVoice] Realtime WebSocket error', err);
                if (this._trace) {
                    this._trace.errors.push('Realtime WebSocket error');
                    _turnLog(this._trace, 'ws error');
                }
                this.emit('error', new Error('Realtime WebSocket error'));
            };

            this.ws.onclose = () => {
                console.log('[nVoice] Realtime WebSocket closed');
                this._emitDisconnected();
            };

        } catch (error) {
            this._starting = false;
            // A failed start must leave the system exactly as it was before the
            // call. Without this teardown every retry leaked the mic stream and
            // up to two AudioContexts; after ~3 retries the browser's context
            // quota was exhausted and every later new AudioContext() was born
            // closed — "AudioWorkletNode cannot be created". stop() closes both
            // contexts and releases the mic; all fields are null-guarded.
            try { this.stop(); } catch { /* teardown must not mask the real error */ }
            this.emit('error', error);
            throw error;
        }
        this._starting = false;
    }

    /**
     * Cloud realtime: connect directly to the provider via WebSocket.
     * The browser captures mic audio, converts to PCM 16kHz, and sends as base64 chunks.
     * Transcript events are received via the WebSocket and emitted as normal events.
     */
    async _startCloudRealtime(session, audioStream) {
        const { httpBase } = this._apiBase();

        // 1. Fetch a single-use token from our server
        const tokenUrl = `${httpBase}${session.token_endpoint}?model=${encodeURIComponent(session.model)}`;
        console.log('[nVoice] Fetching cloud token from', tokenUrl);
        const tokenResp = await fetch(tokenUrl);
        if (!tokenResp.ok) {
            throw new Error('Failed to fetch cloud token: ' + tokenResp.status);
        }
        const tokenData = await tokenResp.json();
        const token = tokenData.token;
        console.log('[nVoice] Cloud token received');

        // 2. Connect to ElevenLabs WebSocket
        const wsParams = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token,
            include_timestamps: 'true',
            commit_strategy: 'vad',
            vad_silence_threshold_secs: '1.5',
            vad_threshold: '0.4',
        });
        this._cloudExpectTimestamps = true;
        const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${wsParams}`;
        console.log('[nVoice] Connecting to ElevenLabs WebSocket...');

        this._cloudWs = new WebSocket(wsUrl);

        // 3. Set up audio capture → PCM 16kHz → base64 chunks
        this._cloudAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = this._cloudAudioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for broad compatibility (AudioWorklet is complex for this use case)
        const bufferSize = 4096;
        this._cloudProcessor = this._cloudAudioContext.createScriptProcessor(bufferSize, 1, 1);

        this._cloudProcessor.onaudioprocess = (e) => {
            if (!this._cloudWs || this._cloudWs.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            // Convert float32 [-1, 1] to int16 PCM
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const sample = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }

            // Send as base64 chunk
            const bytes = new Uint8Array(pcm16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);

            this._cloudWs.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64,
                commit: false,
                sample_rate: 16000,
            }));
        };

        source.connect(this._cloudProcessor);
        // ScriptProcessorNode must connect to destination to work (even if silent)
        const silentGain = this._cloudAudioContext.createGain();
        silentGain.gain.value = 0;
        this._cloudProcessor.connect(silentGain);
        silentGain.connect(this._cloudAudioContext.destination);

        // 4. Handle WebSocket events
        this._cloudWs.onopen = () => {
            console.log('[nVoice] ElevenLabs WebSocket connected, starting audio capture');
        };

        this._cloudWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.message_type) {
                    case 'session_started':
                        console.log('[nVoice] ElevenLabs session started:', msg.session_id);
                        this.emit('connected');
                        break;

                    case 'partial_transcript':
                        if (msg.text) {
                            this.emit('transcript', { text: msg.text, is_final: false });
                        }
                        break;

                    case 'committed_transcript':
                        // Skip — committed_transcript_with_timestamps will fire next
                        // with the same text plus word data. Only emit if timestamps
                        // are disabled (in which case this is the only committed event).
                        if (!this._cloudExpectTimestamps && msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'committed_transcript_with_timestamps':
                        if (msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'error':
                    case 'input_error':
                        console.error('[nVoice] ElevenLabs error:', msg);
                        this.emit('error', new Error('ElevenLabs: ' + (msg.error || JSON.stringify(msg))));
                        break;
                }
            } catch (e) {
                console.error('[nVoice] Failed to parse WebSocket message:', e);
            }
        };

        this._cloudWs.onerror = (error) => {
            console.error('[nVoice] ElevenLabs WebSocket error:', error);
            this.emit('error', new Error('ElevenLabs WebSocket error'));
        };

        this._cloudWs.onclose = () => {
            console.log('[nVoice] ElevenLabs WebSocket closed');
            this._emitDisconnected();
        };
    }

    _stopCloudRealtime() {
        if (this._cloudProcessor) {
            this._cloudProcessor.disconnect();
            this._cloudProcessor = null;
        }
        if (this._cloudAudioContext) {
            this._cloudAudioContext.close();
            this._cloudAudioContext = null;
        }
        if (this._cloudWs) {
            if (this._cloudWs.readyState === WebSocket.OPEN || this._cloudWs.readyState === WebSocket.CONNECTING) {
                this._cloudWs.close();
            }
            this._cloudWs = null;
        }
    }

    stop() {
        // Clean up cloud realtime if active
        this._stopCloudRealtime();

        // Stop the streaming worklet (mic → WebSocket)
        if (this._streamNode) {
            this._streamNode.disconnect();
            this._streamNode = null;
        }
        if (this._streamContext) {
            this._streamContext.close();
            this._streamContext = null;
        }

        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.emit('standby');
    }

    /**
     * End-of-session teardown, emitted exactly once. `disconnect()` emits it
     * eagerly and the socket's own onclose would emit it again a tick later —
     * two 'disconnected' events for one session is a trap for consumers.
     */
    _emitDisconnected() {
        if (this._disconnected) return;
        this._disconnected = true;
        this._clearConnectTimer();
        try {
            if (this._trace) {
                _turnLog(this._trace, 'ws disconnected');
                this.printSessionReport('disconnected');
            }
        } catch (err) {
            // A broken report must not swallow the teardown event — consumers use it
            // to release the UI (Start buttons, spinners).
            console.error('[nVoice] session report failed', err);
        }
        this.emit('disconnected');
    }

    _clearConnectTimer() {
        if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    }

    disconnect() {
        this.stop();

        if (this._kimiWs) {
            if (this._kimiWs.readyState === WebSocket.OPEN || this._kimiWs.readyState === WebSocket.CONNECTING) {
                this._kimiWs.close();
            }
            this._kimiWs = null;
        }
        this.kimiWakeEnabled = false;

        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this._emitDisconnected();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nVoiceClient };
} else if (typeof window !== 'undefined') {
    window.nVoiceClient = nVoiceClient;
}
