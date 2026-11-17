import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const appClass = `${source.slice(source.indexOf('class App {'), source.lastIndexOf('// Initialize on DOM ready'))}\nApp;`;

function fixture() {
    let now = 0, nextId = 0;
    const timers = new Map(), frames = [], elements = [], notices = [];
    const document = {
        createElement() {
            const classes = new Set();
            return { classes, removed: false,
                classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
                remove() { this.removed = true; },
            };
        },
        body: { appendChild: element => elements.push(element) },
    };
    const App = vm.runInNewContext(appClass, {
        document, getCurrentWindow: () => ({}),
        requestAnimationFrame: fn => frames.push(fn),
        setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    const app = new App();
    app.diagnostics = { notice: message => notices.push(message) };
    const frame = () => { for (const fn of frames.splice(0)) fn(); };
    function tick(ms) {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at; timers.delete(id); timer.fn(); frame();
        }
        now = end;
    }
    return { app, timers, elements, notices, frame, tick,
        visible: () => elements.filter(element => !element.removed && element.classes.has('show')).map(element => element.textContent),
        show(message, type = 'error') { app._showToast(message, type); frame(); },
    };
}

test('errors stay visible for two seconds starting from their visible frame', () => {
    const f = fixture();
    f.app._showToast('device stopped', 'error');
    f.tick(5000);
    assert.equal(f.timers.size, 0, 'a delayed animation frame must not consume display time');
    f.frame(); f.tick(1999);
    assert.deepEqual(f.visible(), ['device stopped']);
    f.tick(1);
    assert.deepEqual(f.visible(), []);
    f.tick(300);
    assert.ok(f.elements.every(element => element.removed));
});

test('a routine notice cannot replace an error before two seconds', () => {
    const f = fixture();
    f.show('connection failed'); f.tick(500);
    f.show('settings saved', 'success'); f.tick(1499);
    assert.deepEqual(f.visible(), ['connection failed']);
    f.tick(1);
    assert.deepEqual(f.visible(), ['settings saved']);
    f.tick(2999);
    assert.deepEqual(f.visible(), ['settings saved']);
    f.tick(1);
    assert.deepEqual(f.visible(), []);
});

test('pending errors take precedence over status notices and are logged only on arrival', () => {
    const f = fixture();
    f.show('first error'); f.tick(500);
    f.show('settings saved', 'success');
    f.show('second error');
    f.show('record saved', 'success');
    f.show('first error'); // A duplicate must not prolong the active message.
    f.tick(1500);
    assert.deepEqual(f.visible(), ['second error']);
    assert.deepEqual(f.notices, ['first error', 'second error', 'first error']);
    f.tick(1999);
    assert.deepEqual(f.visible(), ['second error']);
    f.tick(1);
    assert.deepEqual(f.visible(), []);
    assert.equal(f.timers.size, 1, 'only the fade-out cleanup remains');
});

test('errors replace ordinary notices immediately and ignore the old removal timer', () => {
    const f = fixture();
    f.show('settings saved', 'success'); f.tick(1500);
    f.show('connection failed'); f.tick(1500);
    assert.deepEqual(f.visible(), ['connection failed']);
    assert.equal(f.elements[0].removed, true);
    f.tick(499);
    assert.deepEqual(f.visible(), ['connection failed']);
    f.tick(1);
    assert.deepEqual(f.visible(), []);
});

test('a stale animation callback cannot display or schedule a replaced notice', () => {
    const f = fixture();
    f.app._showToast('saved', 'success');
    f.app._showToast('failed', 'error');
    f.frame();
    assert.deepEqual(f.visible(), ['failed']);
    assert.equal(f.timers.size, 1);
    f.tick(2000);
    assert.deepEqual(f.visible(), []);
});
