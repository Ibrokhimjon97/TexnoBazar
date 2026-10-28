/**
 * BackgroundKeepAlive
 * 
 * Prevents mobile browsers (Chrome on Android, iOS Safari) from pausing/freezing
 * Web Bluetooth and JavaScript print loops when:
 * 1. The screen turns off / screen backlight dims (Screen Wake Lock API).
 * 2. The user switches to another app or minimizes the browser (Web Audio Keep-Alive).
 */

class BackgroundKeepAliveManager {
  constructor() {
    this.wakeLock = null;
    this.audioCtx = null;
    this.oscillator = null;
    this.active = false;
    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  async _handleVisibilityChange() {
    if (this.active && document.visibilityState === 'visible') {
      // Re-request wakeLock if dropped while tab was in background
      try {
        if ('wakeLock' in navigator && !this.wakeLock) {
          this.wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (e) {
        // Silently continue if wake lock cannot be re-acquired
      }

      // Resume audio context if browser suspended it
      try {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }
      } catch (e) {}
    }
  }

  async start() {
    if (this.active) return;
    this.active = true;

    // 1. Screen Wake Lock API (keeps device screen awake and backlight on)
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      }
    } catch (e) {
      console.warn('[KeepAlive] WakeLock not granted:', e?.message || e);
    }

    try {
      document.addEventListener('visibilitychange', this._handleVisibilityChange);
    } catch (e) {}

    // 2. Web Audio API silent keep-alive
    // Browsers don't freeze the JS event loop and Web Bluetooth GATT operations
    // while the tab is actively outputting audio (even inaudible silence).
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
          this.audioCtx = new AudioCtx();
        }
        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }

        if (!this.oscillator) {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          // Amplitude is practically zero (inaudible) so no sound is heard
          gain.gain.setValueAtTime(0.00001, this.audioCtx.currentTime);
          osc.frequency.setValueAtTime(220, this.audioCtx.currentTime);
          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start();
          this.oscillator = osc;
        }
      }
    } catch (e) {
      console.warn('[KeepAlive] Audio keepalive failed:', e?.message || e);
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;

    try {
      document.removeEventListener('visibilitychange', this._handleVisibilityChange);
    } catch (e) {}

    try {
      if (this.wakeLock) {
        this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (e) {}

    try {
      if (this.oscillator) {
        this.oscillator.stop();
        this.oscillator.disconnect();
        this.oscillator = null;
      }
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close();
        this.audioCtx = null;
      }
    } catch (e) {}
  }

  isActive() {
    return this.active;
  }
}

export const backgroundKeepAlive = new BackgroundKeepAliveManager();
