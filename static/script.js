/* ====== Эталонные частоты стандартного строя (E2-A2-D3-G3-B3-E4) ====== */
const STANDARD_TUNING = [
  { name: "E2", freq: 82.4069, id: "E_low"  },
  { name: "A2", freq:110.0000, id: "A"      },
  { name: "D3", freq:146.8324, id: "D"      },
  { name: "G3", freq:196.0000, id: "G"      },
  { name: "B3", freq:246.9417, id: "B"      },
  { name: "E4", freq:329.6276, id: "E_high" },
];

/* ====== DOM ====== */
const micBtn      = document.getElementById("micBtn");
const needleEl    = document.getElementById("needle");
const noteEl      = document.getElementById("note");
const freqEl      = document.getElementById("freq");
const targetNoteEl= document.getElementById("targetNote");
const targetFreqEl= document.getElementById("targetFreq");
const hintEl      = document.getElementById("hint");

/* ====== Аудио для эталонных звуков ====== */
function playSound(note) {
  const audio = new Audio(`/static/sounds/${note}.mp3`);
  audio.play();
}

/* ====== Состояние для микрофона/анализа ====== */
let audioCtx, analyser, micStream, workBuf;
let rafId = null;
const SAMPLE_RATE = 48000;           // большинство браузеров дадут 48k
const FFT_SIZE    = 2048;            // компромисс между отзывчивостью и точностью
const MIN_DB      = -60;

const SMOOTHING_TIME_CONSTANT = 0.85; // сглаживание амплитуды
const MIN_FREQ = 60;  // нижняя граница для гитары
const MAX_FREQ = 1000;
const MIN_RMS  = 0.008; // шумовой порог

// скользящее сглаживание частоты (медиана последних N)
const smoothN = 5;
const lastFreqs = [];

/* ====== Включение/выключение микрофона ====== */
micBtn.addEventListener("click", async () => {
  if (rafId) {
    stopTuner();
  } else {
    await startTuner();
  }
});

async function startTuner() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation:false, noiseSuppression:false, autoGainControl:false
    }});
  } catch (e) {
    hintEl.textContent = "Нет доступа к микрофону. Разреши доступ в браузере/Telegram.";
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  const source = audioCtx.createMediaStreamSource(micStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;
  analyser.minDecibels = MIN_DB;

  source.connect(analyser);

  workBuf = new Float32Array(analyser.fftSize);
  micBtn.textContent = "Выключить микрофон";
  micBtn.classList.add("primary");

  loop();
  hintEl.textContent = "Играйте одну открытую струну. Цель — добиться 0¢.";
}

function stopTuner() {
  cancelAnimationFrame(rafId);
  rafId = null;
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  micStream = null; audioCtx = null; analyser = null;

  micBtn.textContent = "Включить микрофон";
  micBtn.classList.add("primary");

  // сброс отображения
  rotateNeedle(0);
  noteEl.textContent = "—";
  freqEl.textContent = "— Hz";
  targetNoteEl.textContent = "—";
  targetFreqEl.textContent = "— Hz";
  hintEl.textContent = "Нажми «Включить микрофон» и извлеки чистый звук одной струны.";
}

/* ====== Главный цикл анализа ====== */
function loop() {
  rafId = requestAnimationFrame(loop);

  analyser.getFloatTimeDomainData(workBuf);

  // проверка RMS (уровня сигнала)
  let rms = 0;
  for (let i = 0; i < workBuf.length; i++) rms += workBuf[i] * workBuf[i];
  rms = Math.sqrt(rms / workBuf.length);
  if (rms < MIN_RMS) {
    showNoPitch("Слабый сигнал или шум — сыграй громче/чище.");
    return;
  }

  const freq = detectPitchAutocorr(workBuf, audioCtx.sampleRate);
  if (!freq || freq < MIN_FREQ || freq > MAX_FREQ) {
    showNoPitch("Не удалось распознать устойчивую высоту. Попробуй ещё раз.");
    return;
  }

  // сглаживание
  lastFreqs.push(freq);
  if (lastFreqs.length > smoothN) lastFreqs.shift();
  const smoothFreq = median(lastFreqs);

  const nearest = nearestStandard(smoothFreq);
  const cents = centsDiff(smoothFreq, nearest.freq);
  updateUI(smoothFreq, nearest, cents);
}

/* ====== Автокорреляция (AMDF/макс. корреляция) ======
   Проста, стабильна для гитары и не требует FFT.
*/
function detectPitchAutocorr(buf, sampleRate) {
  const SIZE = buf.length;
  const MAX_LAG = Math.floor(sampleRate / MIN_FREQ);
  const MIN_LAG = Math.floor(sampleRate / MAX_FREQ);

  let bestLag = -1;
  let bestCorr = 0;

  // Нормировка (убираем DC)
  let mean = 0;
  for (let i = 0; i < SIZE; i++) mean += buf[i];
  mean /= SIZE;
  for (let i = 0; i < SIZE; i++) buf[i] -= mean;

  // Вычисляем автокорреляцию на лаге [MIN_LAG..MAX_LAG]
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let corr = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      corr += buf[i] * buf[i + lag];
    }
    corr /= (SIZE - lag);

    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Порог корреляции — чтобы отсечь шум
  if (bestCorr < 0.01) return null;

  // Парболическая интерполяция вершины
  const lag = bestLag;
  const c0 = autocorrAt(buf, lag - 1);
  const c1 = autocorrAt(buf, lag);
  const c2 = autocorrAt(buf, lag + 1);

  let refinedLag = lag;
  const denom = (c0 - 2 * c1 + c2);
  if (denom !== 0) refinedLag = lag + 0.5 * (c0 - c2) / denom;

  return sampleRate / refinedLag;

  function autocorrAt(buffer, l) {
    if (l < MIN_LAG || l > MAX_LAG) return -Infinity;
    let sum = 0;
    for (let i = 0; i < SIZE - l; i++) sum += buffer[i] * buffer[i + l];
    return sum / (SIZE - l);
  }
}

/* ====== Вспомогательные ====== */
function nearestStandard(freq) {
  let best = STANDARD_TUNING[0];
  let minDiff = Math.abs(freq - best.freq);
  for (const n of STANDARD_TUNING) {
    const d = Math.abs(freq - n.freq);
    if (d < minDiff) { minDiff = d; best = n; }
  }
  return best;
}

function centsDiff(freq, ref) {
  return 1200 * Math.log2(freq / ref);
}

function rotateNeedle(cents) {
  // ограничим видимую шкалу ±50¢, поворот ±45°
  const clamped = Math.max(-50, Math.min(50, cents));
  const deg = (clamped / 50) * 45;
  needleEl.style.transform = `translateX(-50%) rotate(${deg}deg)`;
}

function median(arr){
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

function showNoPitch(msg){
  rotateNeedle(0);
  hintEl.textContent = msg;
  noteEl.textContent = "—";
  freqEl.textContent = "— Hz";
  const nearest = {name:"—", freq:"—"};
  targetNoteEl.textContent = nearest.name;
  targetFreqEl.textContent = `${nearest.freq} Hz`;
}

function updateUI(freq, nearest, cents){
  noteEl.textContent = freq.toFixed(2) >= 100 ? freqToName(freq) : "—";
  freqEl.textContent = `${freq.toFixed(2)} Hz`;
  targetNoteEl.textContent = nearest.name;
  targetFreqEl.textContent = `${nearest.freq.toFixed(2)} Hz`;

  rotateNeedle(cents);

  // Подсказка: ниже/выше
  const dir = cents < -3 ? "Низко (подтянуть)"
           : cents >  3 ? "Высоко (ослабить)"
           : "Идеально!";
  hintEl.textContent = `${dir} · отклонение ${cents.toFixed(1)}¢`;
}

/* Грубое имя ноты из частоты (для «Обнаружено»), не обязательно из строя */
function freqToName(freq){
  const A4 = 440;
  const n = Math.round(12 * Math.log2(freq / A4));
  const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const name = noteNames[(n + 9 + 1200) % 12]; // сдвиг так, чтобы 0 => A
  const midi = n + 69;
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/* Экспортируем playSound в глобал (кнопки эталона) */
window.playSound = playSound;
