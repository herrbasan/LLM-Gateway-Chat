// ============================================
// TtsPlayerHost — floating collapsible TTS chrome
// ============================================
// Close (X) dismisses chrome only. Audio stays until speak() or stop().
// Collapsed chip = mini playback (play/pause icon + progress), not volume.

export class TtsPlayerHost {
    constructor({ controller, mount, nui = null }) {
        if (!controller) throw new Error('TtsPlayerHost: controller required');
        if (!mount) throw new Error('TtsPlayerHost: mount element required');
        this.controller = controller;
        this.mount = mount;
        this._nui = nui;
        this.root = null;
        this._els = null;
        this._dragCleanups = [];
        this._unsubs = [];
        this._collapsed = false;
        this._visible = false;
        this._seeking = false;
        this._dismissed = false;
        this._onState = this._onState.bind(this);
        this._onTime = this._onTime.bind(this);
        this._onDismiss = this._onDismiss.bind(this);
    }

    attach() {
        if (this.root) return;
        const root = document.createElement('div');
        root.className = 'tts-player';
        root.hidden = true;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', 'Text to speech player');
        root.innerHTML = [
            '<div class="tts-player-chip" data-tts-action="expand" title="Show player">',
            '<nui-icon name="pause" class="tts-player-chip-icon" decorative></nui-icon>',
            '<span class="tts-player-chip-bar" aria-hidden="true"><span class="tts-player-chip-fill"></span></span>',
            '</div>',
            '<div class="tts-player-panel">',
            '<div class="tts-player-row tts-player-main">',
            '<nui-button variant="icon" class="tts-player-btn" title="Play/Pause">',
            '<button type="button" data-tts-action="toggle" aria-label="Play or pause">',
            '<nui-icon name="play" class="tts-player-icon-play"></nui-icon>',
            '</button></nui-button>',
            '<div class="tts-player-time" aria-hidden="true">',
            '<span data-tts-current>0:00</span><span class="tts-player-time-sep">/</span><span data-tts-duration>0:00</span>',
            '</div>',
            '<nui-button variant="icon" class="tts-player-btn tts-player-btn-ghost" title="Collapse">',
            '<button type="button" data-tts-action="collapse" aria-label="Collapse player">',
            '<nui-icon name="arrow" class="tts-player-collapse-icon"></nui-icon>',
            '</button></nui-button>',
            '<nui-button variant="icon" class="tts-player-btn tts-player-btn-ghost" title="Hide player (keeps audio)">',
            '<button type="button" data-tts-action="dismiss" aria-label="Hide player">',
            '<nui-icon name="close"></nui-icon>',
            '</button></nui-button>',
            '</div>',
            '<div class="tts-player-row tts-player-scrub-row">',
            '<div class="tts-player-scrub" data-tts-scrub tabindex="0" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">',
            '<div class="tts-player-scrub-track">',
            '<div class="tts-player-scrub-buffer" data-tts-buffer></div>',
            '<div class="tts-player-scrub-fill" data-tts-fill></div>',
            '</div></div></div></div>'
        ].join('');
        this.mount.appendChild(root);
        this.root = root;
        this._els = {
            chip: root.querySelector('.tts-player-chip'),
            chipIcon: root.querySelector('.tts-player-chip-icon'),
            chipFill: root.querySelector('.tts-player-chip-fill'),
            panel: root.querySelector('.tts-player-panel'),
            toggleBtn: root.querySelector('[data-tts-action="toggle"]'),
            playIcon: root.querySelector('.tts-player-icon-play'),
            current: root.querySelector('[data-tts-current]'),
            duration: root.querySelector('[data-tts-duration]'),
            scrub: root.querySelector('[data-tts-scrub]'),
            fill: root.querySelector('[data-tts-fill]'),
            buffer: root.querySelector('[data-tts-buffer]'),
        };
        root.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-tts-action]');
            if (!actionEl || !root.contains(actionEl)) return;
            const action = actionEl.getAttribute('data-tts-action');
            if (action === 'toggle') {
                this.reveal();
                this.controller.togglePause();
            } else if (action === 'dismiss') {
                this.dismiss();
            } else if (action === 'collapse') {
                this.setCollapsed(true);
            } else if (action === 'expand') {
                this.setCollapsed(false);
            }
        });
        const bind = () => this._wireScrub();
        const nui = this._nuiApi();
        if (nui && nui.ready) nui.ready().then(bind);
        else requestAnimationFrame(bind);

        this._unsubs.push(this.controller.on('state', this._onState));
        this._unsubs.push(this.controller.on('time', this._onTime));
        this._unsubs.push(this.controller.on('dismiss', this._onDismiss));
        if (this.controller.isActive()) {
            this._onState({ state: this.controller.getPlaybackState(), targetEl: this.controller.targetEl });
            this._onTime(this.controller.getTimes());
        }
    }

    destroy() {
        for (const off of this._unsubs) off();
        this._unsubs = [];
        for (const c of this._dragCleanups) c();
        this._dragCleanups = [];
        if (this.root) { this.root.remove(); this.root = null; this._els = null; }
        this._visible = false;
        this._dismissed = false;
    }

    dismiss() {
        this._dismissed = true;
        this.controller.dismiss();
        this._hide();
    }

    reveal() {
        if (!this._dismissed && this._visible) return;
        this._dismissed = false;
        if (!this.controller.isActive()) return;
        this._show();
        this._onState({ state: this.controller.getPlaybackState(), targetEl: this.controller.targetEl });
        this._onTime(this.controller.getTimes());
    }

    setCollapsed(collapsed) {
        this._collapsed = !!collapsed;
        if (!this.root) return;
        this.root.classList.toggle('is-collapsed', this._collapsed);
    }

    _nuiApi() { return this._nui || window.nui || null; }

    _wireScrub() {
        if (!this._els || this._dragCleanups.length) return;
        const scrub = this._els.scrub;
        const nui = this._nuiApi();
        const enableDrag = nui && nui.util && nui.util.enableDrag;

        const onScrub = (data) => {
            if (!this.controller.audio) return;
            if (data.type === 'start') {
                this._seeking = true;
                this.controller.setSeekDragging(true);
                this.root.classList.add('is-seeking');
            }
            const times = this.controller.getTimes();
            let max = times.timelineMax || Math.max(times.duration || 0, times.bufferedEnd || 0, times.currentTime || 0);
            if (!(max > 0)) max = 1;
            const t = data.percentX * max;
            this._paintTime({
                currentTime: t,
                duration: times.duration,
                bufferedEnd: times.bufferedEnd,
                timelineMax: max,
            });
            this.controller.seek(t);
            if (data.type === 'end') {
                this._seeking = false;
                this.controller.setSeekDragging(false);
                this.root.classList.remove('is-seeking');
            }
        };

        if (enableDrag) {
            this._dragCleanups.push(enableDrag(scrub, onScrub));
        } else {
            const clickPct = (el, e) => {
                const r = el.getBoundingClientRect();
                return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(r.width, 1)));
            };
            const scrubClick = (e) => {
                if (!this.controller.audio) return;
                const p = clickPct(scrub, e);
                onScrub({ type: 'start', percentX: p });
                onScrub({ type: 'end', percentX: p });
            };
            scrub.addEventListener('click', scrubClick);
            this._dragCleanups.push(() => scrub.removeEventListener('click', scrubClick));
        }

        scrub.addEventListener('keydown', (e) => {
            if (!this.controller.audio) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.controller.seekBy(e.shiftKey ? -15 : -5); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this.controller.seekBy(e.shiftKey ? 15 : 5); }
            else if (e.key === 'Home') { e.preventDefault(); this.controller.seek(0); }
        });
    }

    _onDismiss() {
        this._dismissed = true;
        this._hide();
    }

    _onState({ state }) {
        if (!this.root) this.attach();
        if (state === 'idle') {
            this._dismissed = false;
            this._hide();
            return;
        }
        if (state === 'loading') this._dismissed = false;
        if (this._dismissed) return;
        this._show();
        this.root.dataset.state = state;
        this.root.classList.toggle('is-loading', state === 'loading');
        this.root.classList.toggle('is-playing', state === 'playing');
        this.root.classList.toggle('is-paused', state === 'paused');

        const playName = state === 'loading' ? 'sync' : (state === 'playing' ? 'pause' : 'play');
        if (this._els.playIcon) this._els.playIcon.setAttribute('name', playName);
        if (this._els.chipIcon) this._els.chipIcon.setAttribute('name', playName);

        const toggle = this._els.toggleBtn;
        if (toggle) {
            if (state === 'loading') toggle.setAttribute('aria-label', 'Loading');
            else if (state === 'playing') toggle.setAttribute('aria-label', 'Pause');
            else toggle.setAttribute('aria-label', 'Play');
        }
    }

    _onTime(times) {
        if (!this._visible || !this._els) return;
        // While seeking, still paint buffer growth so the bar keeps filling.
        if (this._seeking) {
            this._paintTime({
                ...times,
                currentTime: this.controller.audio?.currentTime || times.currentTime || 0,
            });
            return;
        }
        this._paintTime(times);
    }

    _paintTime({ currentTime = 0, duration = 0, bufferedEnd = 0, timelineMax = 0 }) {
        const els = this._els;
        if (!els) return;
        els.current.textContent = formatTime(currentTime);
        // Prefer known duration; else growing buffer/timeline (generation still running).
        const shownDur = duration > 0
            ? duration
            : Math.max(timelineMax, bufferedEnd, currentTime);
        els.duration.textContent = formatTime(shownDur);
        const max = Math.max(timelineMax, duration, bufferedEnd, currentTime, 0);
        const pct = max > 0 ? (currentTime / max) * 100 : 0;
        const bufPct = max > 0 ? (bufferedEnd / max) * 100 : 0;
        // Playhead (current) stays put when paused; buffer lane grows as stream arrives.
        els.fill.style.width = pct.toFixed(3) + '%';
        els.buffer.style.width = bufPct.toFixed(3) + '%';
        // Collapsed chip shows buffer progress while paused so it still "fills up".
        if (els.chipFill) {
            const chipPct = this.root?.classList.contains('is-paused')
                ? Math.max(pct, bufPct)
                : pct;
            els.chipFill.style.width = chipPct.toFixed(3) + '%';
        }
        els.scrub.setAttribute('aria-valuemin', '0');
        els.scrub.setAttribute('aria-valuemax', String(Math.round(max)));
        els.scrub.setAttribute('aria-valuenow', String(Math.round(currentTime)));
    }

    _show() {
        if (!this.root) this.attach();
        this.root.hidden = false;
        this._visible = true;
        this.root.classList.toggle('is-collapsed', this._collapsed);
        if (!this._dragCleanups.length) {
            const nui = this._nuiApi();
            if (nui && nui.ready) nui.ready().then(() => this._wireScrub());
            else this._wireScrub();
        }
    }

    _hide() {
        if (!this.root) return;
        this.root.hidden = true;
        this._visible = false;
        this.root.dataset.state = 'idle';
        this.root.classList.remove('is-loading', 'is-playing', 'is-paused', 'is-seeking');
        this._collapsed = false;
        this.root.classList.remove('is-collapsed');
        this._paintTime({ currentTime: 0, duration: 0, bufferedEnd: 0 });
    }
}

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const ss = String(s).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
    return m + ':' + ss;
}