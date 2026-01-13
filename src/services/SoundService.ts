/**
 * ♠ CLUB ARENA — Sound Service
 * Procedural audio generation for poker actions using Web Audio API
 */

class SoundService {
    private ctx: AudioContext | null = null;
    private enabled: boolean = true;

    constructor() {
        // Initialize on first user interaction usually, but we define here
        try {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            if (AudioContextClass) {
                this.ctx = new AudioContextClass();
            }
        } catch (e) {
            console.error('Web Audio API not supported', e);
        }
    }

    private ensureContext() {
        if (!this.ctx) return false;
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        return true;
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
    }

    /**
     * Play a chip betting sound (short click/clack)
     */
    playChips() {
        if (!this.enabled || !this.ensureContext()) return;
        const t = this.ctx!.currentTime;

        // High frequency click
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();

        osc.frequency.setValueAtTime(2000, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + 0.05);

        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.05);

        osc.connect(gain);
        gain.connect(this.ctx!.destination);

        osc.start(t);
        osc.stop(t + 0.05);

        // Second click slightly delayed (stacking sound)
        setTimeout(() => {
            if (!this.ctx) return;
            const t2 = this.ctx.currentTime;
            const osc2 = this.ctx.createOscillator();
            const gain2 = this.ctx.createGain();
            osc2.frequency.setValueAtTime(2500, t2);
            osc2.frequency.exponentialRampToValueAtTime(200, t2 + 0.04);
            gain2.gain.setValueAtTime(0.2, t2);
            gain2.gain.exponentialRampToValueAtTime(0.01, t2 + 0.04);
            osc2.connect(gain2);
            gain2.connect(this.ctx.destination);
            osc2.start(t2);
            osc2.stop(t2 + 0.04);
        }, 30);
    }

    /**
     * Play check sounds (double tap)
     */
    playCheck() {
        if (!this.enabled || !this.ensureContext()) return;
        const t = this.ctx!.currentTime;

        // Wood-like thud
        this.createNoiseBurst(t, 0.05);
        setTimeout(() => this.createNoiseBurst(this.ctx!.currentTime, 0.05), 150);
    }

    /**
     * Play fold sound (whoosh)
     */
    playFold() {
        if (!this.enabled || !this.ensureContext()) return;
        const t = this.ctx!.currentTime;

        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        const filter = this.ctx!.createBiquadFilter();

        osc.type = 'sawtooth';
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, t);
        filter.frequency.linearRampToValueAtTime(100, t + 0.2);

        gain.gain.setValueAtTime(0.2, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx!.destination);

        osc.start(t);
        osc.stop(t + 0.2);
    }

    /**
     * Play "Your Turn" alert (bell)
     */
    playTurnAlert() {
        if (!this.enabled || !this.ensureContext()) return;
        const t = this.ctx!.currentTime;

        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t); // A5

        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.8);

        osc.connect(gain);
        gain.connect(this.ctx!.destination);

        osc.start(t);
        osc.stop(t + 0.8);
    }

    /**
     * Play win sound (arpeggio)
     */
    playWin() {
        if (!this.enabled || !this.ensureContext()) return;
        const t = this.ctx!.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.50]; // C Major

        notes.forEach((freq, i) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            const startTime = t + i * 0.1;

            osc.frequency.setValueAtTime(freq, startTime);
            gain.gain.setValueAtTime(0.2, startTime);
            gain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.5);

            osc.connect(gain);
            gain.connect(this.ctx!.destination);

            osc.start(startTime);
            osc.stop(startTime + 0.5);
        });
    }

    /**
     * Internal helper for noise (snare/hit)
     */
    private createNoiseBurst(time: number, duration: number) {
        if (!this.ctx) return;
        const bufferSize = this.ctx.sampleRate * duration;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1000;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.2, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start(time);
    }
}

export const soundService = new SoundService();
