// Web Audio API yordamida zamonaviy va sifatli signal tovushlari (faylsiz, brauzerning o‘zida sintez qilinadi).

let audioCtx = null;

export function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Brauzerning autoplay siyosatini chetlab o'tish uchun birinchi bosishda AudioContext ni uyg'otish
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    } catch (_) {}
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { passive: true, once: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true, once: true });
  window.addEventListener('keydown', unlockAudio, { passive: true, once: true });
}

export function isAudioEnabled() {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem('texnobazar:audio-alerts-enabled') !== 'false';
}

export function setAudioEnabled(enabled) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('texnobazar:audio-alerts-enabled', enabled ? 'true' : 'false');
}

/**
 * Kassaga yangi savdo so'rovi tushganda chalinadigan jarangdor, yoqimli kassa signali (Ding-Ding chime).
 */
export function playCashierAlert() {
  if (!isAudioEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.35, now);
    masterGain.connect(ctx.destination);

    // 1-ohang: G5 (784 Hz) - Qisqa, aniq boshlanish
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(783.99, now);
    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.exponentialRampToValueAtTime(0.45, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc1.connect(gain1);
    gain1.connect(masterGain);
    osc1.start(now);
    osc1.stop(now + 0.28);

    // 2-ohang: C6 (1046.5 Hz) - Jarangdor asosiy kassa qo'ng'irog'i (0.12 soniya keyin)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1046.5, now + 0.12);
    gain2.gain.setValueAtTime(0.0001, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.6, now + 0.14);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
    osc2.connect(gain2);
    gain2.connect(masterGain);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.65);

    // 3-ohang: E6 (1318.5 Hz) - Chiroyli garmonik yorqinlik
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(1318.51, now + 0.14);
    gain3.gain.setValueAtTime(0.0001, now + 0.14);
    gain3.gain.exponentialRampToValueAtTime(0.25, now + 0.16);
    gain3.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    osc3.connect(gain3);
    gain3.connect(masterGain);
    osc3.start(now + 0.14);
    osc3.stop(now + 0.55);
  } catch (err) {
    console.warn('Cashier audio alert error:', err);
  }
}

/**
 * Tizim bildirishnomalari (buyurtma, qaytarish, ta'mirlash va h.k.) uchun mayin signal.
 */
export function playNotificationAlert() {
  if (!isAudioEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.3, now);
    masterGain.connect(ctx.destination);

    // D5 (587 Hz) -> A5 (880 Hz) mayin juft signal
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc1.connect(gain1);
    gain1.connect(masterGain);
    osc1.start(now);
    osc1.stop(now + 0.22);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.1);
    gain2.gain.setValueAtTime(0.0001, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.4, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc2.connect(gain2);
    gain2.connect(masterGain);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.5);
  } catch (err) {
    console.warn('Notification audio alert error:', err);
  }
}

/**
 * QR/shtrix-kod muvaffaqiyatli skanerlanganda qisqa, yoqimli "bip" signali
 */
export function playScanSuccessBeep() {
  if (!isAudioEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch (err) {
    console.warn('Scan beep error:', err);
  }
}

/**
 * QR kod topilmaganda yoki xatolikda e'tiborni tortuvchi ikkita past signal
 */
export function playScanErrorBeep() {
  if (!isAudioEnabled()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(260, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch (err) {
    console.warn('Scan error beep error:', err);
  }
}

