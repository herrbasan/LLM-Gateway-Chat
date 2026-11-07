import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./hosted-app.js', import.meta.url), 'utf8');
const { hostedApps } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const PUBLIC = 'https://nport.raum.com';
const BACKEND = 'http://192.168.0.100:3100';

test('hosted URLs map host-free and backend-internal paths onto the public origin', () => {
    assert.equal(
        hostedApps.resolveUrl('/print?path=vita%2Fvita.md', PUBLIC, BACKEND).toString(),
        `${PUBLIC}/print?path=vita%2Fvita.md`
    );
    assert.equal(
        hostedApps.resolveUrl(`${BACKEND}/print?path=vita.md`, PUBLIC, BACKEND).toString(),
        `${PUBLIC}/print?path=vita.md`
    );
});

test('hosted URLs reject external origins and missing public mappings instead of falling back internally', () => {
    assert.equal(hostedApps.resolveUrl('https://example.com/print', PUBLIC, BACKEND), null);
    assert.equal(hostedApps.resolveUrl('/print', null, BACKEND), null);
});

test('hosted action uses the browser origin for postMessage correlation and never emits the backend host', () => {
    globalThis.window = { location: { origin: PUBLIC } };
    const action = hostedApps.resolve({
        kind: 'hosted-app',
        id: 'print-vita',
        app: 'print',
        appInstanceId: 'app_12345678-1234-1234-1234-123456789abc',
        title: 'Vita',
        label: 'Open Vita',
        url: `${BACKEND}/print?path=vita.md`
    }, PUBLIC, BACKEND);
    const url = new URL(action.url);
    assert.equal(url.origin, PUBLIC);
    assert.equal(url.searchParams.get('parentOrigin'), PUBLIC);
    assert.equal(url.searchParams.get('hostInstanceId'), 'app_12345678-1234-1234-1234-123456789abc');
    assert.equal(action.mcpOrigin, PUBLIC);
    delete globalThis.window;
});
