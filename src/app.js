"use strict";

/* ============================ 小道具 ============================ */
const $ = id => document.getElementById(id);
// UIに描画の隙をあげる。setTimeoutは非アクティブタブで1秒に間引かれるので
// 間引きの対象外である MessageChannel を使う。
const tick = () => new Promise(r => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); r(); };
  ch.port2.postMessage(0);
});
const clamp = (v,a,b) => v<a?a:(v>b?b:v);

function fmtTime(s){
  const m = Math.floor(s/60), sec = s - m*60;
  return m + ":" + (sec<10?"0":"") + sec.toFixed(1);
}
function fmtTag(s){
  const m = Math.floor(s/60), sec = Math.floor(s-m*60);
  return m + "m" + (sec<10?"0":"") + sec + "s";
}

/* ============================ FFT ============================ */
class FFT {
  constructor(n){
    this.n = n;
    this.levels = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i=0;i<n;i++){
      let j=0, x=i;
      for (let k=0;k<this.levels;k++){ j = (j<<1) | (x&1); x >>= 1; }
      this.rev[i] = j;
    }
    const h = n>>1;
    this.cosT = new Float64Array(h);
    this.sinT = new Float64Array(h);
    for (let i=0;i<h;i++){
      this.cosT[i] = Math.cos(2*Math.PI*i/n);
      this.sinT[i] = Math.sin(2*Math.PI*i/n);
    }
  }
  transform(re, im){
    const n = this.n, rev = this.rev;
    for (let i=0;i<n;i++){
      const j = rev[i];
      if (j > i){
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size=2; size<=n; size <<= 1){
      const half = size>>1, step = n/size;
      for (let i=0;i<n;i+=size){
        for (let j=i, k=0; j<i+half; j++, k+=step){
          const l = j + half;
          const tre =  re[l]*this.cosT[k] + im[l]*this.sinT[k];
          const tim = -re[l]*this.sinT[k] + im[l]*this.cosT[k];
          re[l] = re[j]-tre; im[l] = im[j]-tim;
          re[j] += tre;      im[j] += tim;
        }
      }
    }
  }
}

/* ============================ 解析 ============================ */
const AN_SR = 22050;   // 解析用サンプルレート
const FRAME = 1024;
const HOP   = 256;
const AGG   = 8;       // 特徴フレームの間引き（→約10.8fps）

async function toMonoAnalysis(buf){
  const len = Math.max(1, Math.ceil(buf.duration * AN_SR));
  const oac = new OfflineAudioContext(1, len, AN_SR);
  const src = oac.createBufferSource();
  src.buffer = buf;
  src.connect(oac.destination);
  src.start();
  const out = await oac.startRendering();
  return out.getChannelData(0);
}

function hann(n){
  const w = new Float32Array(n);
  for (let i=0;i<n;i++) w[i] = 0.5 - 0.5*Math.cos(2*Math.PI*i/n);
  return w;
}

/** メルフィルタバンク（非ゼロ区間だけ持つ疎な形で返す） */
function melFilterbank(nMel, nBins, sr, fmin, fmax){
  const toMel = f => 1127*Math.log(1 + f/700);
  const toHz  = m => 700*(Math.exp(m/1127) - 1);
  const mlo = toMel(fmin), mhi = toMel(fmax);
  const pts = new Float64Array(nMel+2);
  for (let i=0;i<nMel+2;i++) pts[i] = toHz(mlo + (mhi-mlo)*i/(nMel+1));
  const binHz = (sr/2)/(nBins-1);
  const bands = [];
  for (let m=0;m<nMel;m++){
    const f0=pts[m], f1=pts[m+1], f2=pts[m+2];
    const s = clamp(Math.floor(f0/binHz), 0, nBins-1);
    const e = clamp(Math.ceil(f2/binHz),  0, nBins-1);
    const w = new Float32Array(Math.max(1, e-s+1));
    for (let b=s;b<=e;b++){
      const f = b*binHz;
      let v = 0;
      if (f>=f0 && f<=f1 && f1>f0) v = (f-f0)/(f1-f0);
      else if (f>f1 && f<=f2 && f2>f1) v = (f2-f)/(f2-f1);
      w[b-s] = v;
    }
    bands.push({ s, e, w });
  }
  return bands;
}

/** スペクトル特徴を一括抽出 */
async function extractFeatures(mono, onProg){
  const nBins = (FRAME>>1) + 1;
  const nFrames = Math.max(1, Math.floor((mono.length - FRAME)/HOP) + 1);
  const fft = new FFT(FRAME);
  const win = hann(FRAME);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const mag = new Float32Array(nBins), pow = new Float32Array(nBins), prevMag = new Float32Array(nBins);

  const NMEL = 20;
  const bands = melFilterbank(NMEL, nBins, AN_SR, 30, AN_SR/2 - 200);

  // クロマ（音名）に使うビンだけ列挙しておく
  const binHz = (AN_SR/2)/(nBins-1);
  const cBin = [], cPc = [];
  for (let b=1;b<nBins;b++){
    const f = b*binHz;
    if (f < 65 || f > 2000) continue;
    cBin.push(b);
    cPc.push((((Math.round(69 + 12*Math.log2(f/440)) % 12) + 12) % 12));
  }
  const chromaBin = Uint16Array.from(cBin), chromaPc = Uint8Array.from(cPc);
  // 低域（キック帯）ビン
  const lowMax = Math.min(nBins-1, Math.round(200/binHz));

  const rms  = new Float32Array(nFrames);
  const flux = new Float32Array(nFrames);
  const low  = new Float32Array(nFrames);
  const chroma = new Float32Array(nFrames*12);
  const mel    = new Float32Array(nFrames*NMEL);

  for (let f=0; f<nFrames; f++){
    const off = f*HOP;
    let e = 0;
    for (let i=0;i<FRAME;i++){
      const s = mono[off+i] || 0;
      e += s*s;
      re[i] = s*win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e/FRAME);
    fft.transform(re, im);

    let fl = 0, lo = 0;
    for (let b=0;b<nBins;b++){
      const rr = re[b], ii = im[b];
      const m = Math.sqrt(rr*rr + ii*ii);
      mag[b] = m; pow[b] = m*m;
      const d = m - prevMag[b];
      if (d > 0) fl += d;
      if (b <= lowMax) lo += m;
    }
    flux[f] = fl;
    low[f]  = lo;

    const cBase = f*12;
    for (let c=0;c<chromaBin.length;c++) chroma[cBase + chromaPc[c]] += mag[chromaBin[c]];

    const mBase = f*NMEL;
    for (let m=0;m<NMEL;m++){
      const bd = bands[m], w = bd.w, s = bd.s, e = bd.e;
      let acc = 0;
      for (let b=s;b<=e;b++) acc += w[b-s]*pow[b];
      mel[mBase+m] = Math.log(acc + 1e-10);
    }
    prevMag.set(mag);

    if ((f & 255) === 0){
      onProg(f/nFrames);
      await tick();
    }
  }
  return { nFrames, NMEL, rms, flux, low, chroma, mel };
}

/** テンポ・拍・小節頭を推定 */
function estimateBeats(flux, nFrames){
  const fps = AN_SR/HOP;
  // オンセット強度：移動平均を引いて半波整流
  const W = Math.round(fps*0.35);
  const on = new Float32Array(nFrames);
  let run = 0;
  for (let i=0;i<nFrames;i++){
    const a = Math.max(0, i-W), b = Math.min(nFrames-1, i+W);
    run = 0;
    for (let j=a;j<=b;j++) run += flux[j];
    on[i] = Math.max(0, flux[i] - run/(b-a+1));
  }
  // 自己相関でテンポ推定（70〜185 BPM）
  const lagMin = Math.round(60/185*fps), lagMax = Math.round(60/70*fps);
  let bestLag = 0, bestVal = -1;
  for (let lag=lagMin; lag<=lagMax; lag++){
    let s = 0;
    for (let i=0;i+lag<nFrames;i++) s += on[i]*on[i+lag];
    const bpm = 60/(lag/fps);
    // 120BPM付近を軽く優遇
    const prior = Math.exp(-Math.pow(Math.log(bpm/120), 2)/(2*0.30*0.30));
    const v = s/Math.max(1, nFrames-lag) * prior;
    if (v > bestVal){ bestVal = v; bestLag = lag; }
  }
  if (bestLag === 0) return { bpm:0, beats:[], downbeats:[], period:0 };

  // 拍の位相
  let bestOff = 0, bestSum = -1;
  for (let off=0; off<bestLag; off++){
    let s = 0;
    for (let k=off; k<nFrames; k+=bestLag) s += on[k];
    if (s > bestSum){ bestSum = s; bestOff = off; }
  }
  const beats = [];
  for (let k=bestOff; k<nFrames; k+=bestLag) beats.push(k*HOP/AN_SR);

  return { bpm: 60/(bestLag/fps), beats, period: bestLag*HOP/AN_SR, downbeats: [] };
}

function estimateDownbeats(beats, lowAgg, featRate){
  if (beats.length < 8) return beats.slice();
  let bestPhase = 0, bestSum = -1;
  for (let p=0;p<4;p++){
    let s = 0;
    for (let i=p;i<beats.length;i+=4){
      const idx = Math.round(beats[i]*featRate);
      if (idx >= 0 && idx < lowAgg.length) s += lowAgg[idx];
    }
    if (s > bestSum){ bestSum = s; bestPhase = p; }
  }
  const db = [];
  for (let i=bestPhase;i<beats.length;i+=4) db.push(beats[i]);
  return db;
}

/** フレーム列を AGG 個ずつ平均して間引く */
function aggregate(arr, nFrames, dim, nAgg){
  const out = new Float32Array(nAgg*dim);
  for (let i=0;i<nAgg;i++){
    const s = i*AGG, e = Math.min(nFrames, s+AGG), n = e-s;
    for (let d=0;d<dim;d++){
      let acc = 0;
      for (let f=s;f<e;f++) acc += arr[f*dim+d];
      out[i*dim+d] = acc/Math.max(1,n);
    }
  }
  return out;
}

/** 構造の切れ目（Footeノベルティ） */
function noveltyCurve(feat, nAgg, D, L){
  // 帯状の自己相似行列（|i-j| <= 2L のみ）
  const B = 2*L;
  const band = new Float32Array(nAgg*(B+1));
  for (let i=0;i<nAgg;i++){
    for (let d=0; d<=B; d++){
      const j = i+d;
      if (j >= nAgg){ band[i*(B+1)+d] = 0; continue; }
      let s = 0;
      for (let k=0;k<D;k++) s += feat[i*D+k]*feat[j*D+k];
      band[i*(B+1)+d] = s;
    }
  }
  const S = (i,j) => {
    i = clamp(i,0,nAgg-1); j = clamp(j,0,nAgg-1);
    const a = Math.min(i,j), d = Math.abs(i-j);
    return d > B ? 0 : band[a*(B+1)+d];
  };
  // チェッカーボード核
  const sig = L/2;
  const K = new Float32Array((2*L+1)*(2*L+1));
  for (let a=-L;a<=L;a++){
    for (let b=-L;b<=L;b++){
      const v = (a===0||b===0) ? 0 : Math.sign(a*b)*Math.exp(-(a*a+b*b)/(2*sig*sig));
      K[(a+L)*(2*L+1)+(b+L)] = v;
    }
  }
  const nov = new Float32Array(nAgg);
  for (let i=0;i<nAgg;i++){
    let acc = 0;
    for (let a=-L;a<=L;a++){
      const krow = (a+L)*(2*L+1);
      for (let b=-L;b<=L;b++){
        const k = K[krow+b+L];
        if (k !== 0) acc += k*S(i+a, i+b);
      }
    }
    nov[i] = acc;
  }
  return nov;
}

function smooth(arr, w){
  const out = new Float32Array(arr.length);
  for (let i=0;i<arr.length;i++){
    const a = Math.max(0,i-w), b = Math.min(arr.length-1,i+w);
    let s = 0;
    for (let j=a;j<=b;j++) s += arr[j];
    out[i] = s/(b-a+1);
  }
  return out;
}

/** 外れ値に強い 0〜1 正規化 */
function normRobust(arr){
  const s = Array.from(arr).sort((a,b)=>a-b);
  const lo = s[Math.floor(s.length*0.05)], hi = s[Math.floor(s.length*0.97)];
  const out = new Float32Array(arr.length);
  const r = Math.max(1e-9, hi-lo);
  for (let i=0;i<arr.length;i++) out[i] = clamp((arr[i]-lo)/r, 0, 1);
  return out;
}

/* ============================ 状態 ============================ */
let ac = null;
let origBuf = null;
let fileName = "audio";
let analysis = null;   // { featRate, dur, bpm, beats, downbeats, comp:{...} }
let picks = [];
let loops = [];
let mode = "cut";              // "cut" = アタマ出し / "loop" = ループ作成
let peaks = null;
let playing = -1, playingMode = "cut", srcNode = null;

/* ============================ メイン解析 ============================ */
async function runAnalysis(){
  const prog = $("prog"), bar = $("progBar"), txt = $("progTxt");
  prog.style.display = "block";
  const setP = (p, t) => { bar.style.width = (p*100).toFixed(1)+"%"; if (t) txt.textContent = t; };

  setP(0.02, "音声を準備中…");
  await tick();
  const mono = await toMonoAnalysis(origBuf);

  setP(0.05, "スペクトルを解析中…");
  const F = await extractFeatures(mono, p => setP(0.05 + p*0.65, "スペクトルを解析中… " + Math.round(p*100) + "%"));

  setP(0.72, "テンポを推定中…");
  await tick();
  const beatInfo = estimateBeats(F.flux, F.nFrames);

  setP(0.78, "曲の構成を解析中…");
  await tick();

  const nAgg = Math.max(1, Math.floor(F.nFrames/AGG));
  const featRate = AN_SR/HOP/AGG;
  const D = 12 + F.NMEL;

  const chA = aggregate(F.chroma, F.nFrames, 12, nAgg);
  const meA = aggregate(F.mel,    F.nFrames, F.NMEL, nAgg);
  const rmA = aggregate(F.rms,    F.nFrames, 1, nAgg);
  const loA = aggregate(F.low,    F.nFrames, 1, nAgg);

  // 特徴ベクトル（クロマとメルをそれぞれ正規化して連結）
  const feat = new Float32Array(nAgg*D);
  for (let i=0;i<nAgg;i++){
    let n1 = 0;
    for (let k=0;k<12;k++) n1 += chA[i*12+k]*chA[i*12+k];
    n1 = Math.sqrt(n1) || 1;
    for (let k=0;k<12;k++) feat[i*D+k] = chA[i*12+k]/n1;

    let mean = 0;
    for (let k=0;k<F.NMEL;k++) mean += meA[i*F.NMEL+k];
    mean /= F.NMEL;
    let n2 = 0;
    for (let k=0;k<F.NMEL;k++){ const v = meA[i*F.NMEL+k]-mean; n2 += v*v; }
    n2 = Math.sqrt(n2) || 1;
    for (let k=0;k<F.NMEL;k++) feat[i*D+12+k] = (meA[i*F.NMEL+k]-mean)/n2;
  }

  const L = clamp(Math.round(featRate*3), 8, 48);
  const nov = smooth(noveltyCurve(feat, nAgg, D, L), 1);

  setP(0.92, "候補を選定中…");
  await tick();

  // dB 化したエネルギー
  const db = new Float32Array(nAgg);
  for (let i=0;i<nAgg;i++) db[i] = 20*Math.log10(rmA[i] + 1e-7);
  const lodb = new Float32Array(nAgg);
  for (let i=0;i<nAgg;i++) lodb[i] = 20*Math.log10(loA[i] + 1e-7);
  const dbS = smooth(db, Math.round(featRate*0.4));

  const mean = (arr,a,b) => {
    a = clamp(a,0,arr.length-1); b = clamp(b,0,arr.length-1);
    if (b < a) return arr[a];
    let s = 0;
    for (let i=a;i<=b;i++) s += arr[i];
    return s/(b-a+1);
  };

  const R  = Math.round(featRate*4.0);   // 盛り上がり判定の窓
  const RS = Math.round(featRate*1.3);   // ドロップ判定の窓
  const RE = Math.round(featRate*6.0);   // 開始直後の元気さ
  const RB = Math.round(featRate*0.7);   // 境界の鋭さを見る窓

  const rise = new Float32Array(nAgg);   // dB
  const drop = new Float32Array(nAgg);   // dB
  const eng  = new Float32Array(nAgg);
  const step = new Float32Array(nAgg);   // 変化の大きさ（増減どちらも）
  for (let i=0;i<nAgg;i++){
    rise[i] = mean(dbS, i, i+R) - mean(dbS, i-R, i-1);
    const dA = mean(dbS, i, i+RS) - mean(dbS, i-RS, i-1);
    const dL = mean(lodb, i, i+RS) - mean(lodb, i-RS, i-1);
    drop[i] = dA*0.55 + dL*0.45;
    eng[i]  = mean(dbS, i, i+RE);
    step[i] = Math.abs(mean(dbS, i, i+RB) - mean(dbS, i-RB, i-1));
  }

  const nNov = normRobust(nov), nRise = normRobust(rise),
        nDrop = normRobust(drop), nEng = normRobust(eng), nStep = normRobust(step);

  const dur = origBuf.duration;
  const downbeats = estimateDownbeats(beatInfo.beats, loA, featRate);

  analysis = {
    featRate, nAgg, dur,
    bpm: beatInfo.bpm, period: beatInfo.period,
    beats: beatInfo.beats, downbeats,
    nNov, nRise, nDrop, nEng, nStep,
    riseDb: rise, dropDb: drop,
    stepRaw: step, novRaw: nov,
    feat, D, db: dbS          // ループ探索で使う
  };

  setP(1, "完了");
  prog.style.display = "none";
  buildPicks();
  buildLoops();
}

/* ============================ 候補選定 ============================ */
/** 拍・小節頭に寄せる。ただし半拍以上は動かさない（拍推定のズレで良い点を壊さないため） */
function snapTime(t){
  const a = analysis;
  if (!$("snap").checked || !a.period) return t;
  const pick = list => {
    let best = null, bd = Infinity;
    for (const v of list){ const d = Math.abs(v-t); if (d < bd){ bd = d; best = v; } }
    return { v: best, d: bd };
  };
  const lim = a.period*0.5;
  if (a.downbeats.length){
    const db = pick(a.downbeats);
    if (db.d <= lim) return db.v;
  }
  if (a.beats.length){
    const b = pick(a.beats);
    if (b.d <= lim) return b.v;
  }
  return t;
}

/** 候補位置を近くの本当の切れ目に寄せる（±2.5秒だけ探す）
 *  音量が急に変わる点（増減どちらも）と構成の切れ目を手掛かりにする */
function refinePos(i){
  const a = analysis;
  const w = Math.round(a.featRate*2.5);
  const lo = Math.max(0, i-w), hi = Math.min(a.nAgg-1, i+w);
  // 全体正規化だと境界付近が上限に張り付いて平坦になるので、窓の中で正規化し直す
  let sMin=Infinity, sMax=-Infinity, nMin=Infinity, nMax=-Infinity;
  for (let j=lo;j<=hi;j++){
    const s = a.stepRaw[j], n = a.novRaw[j];
    if (s<sMin) sMin=s; if (s>sMax) sMax=s;
    if (n<nMin) nMin=n; if (n>nMax) nMax=n;
  }
  const sr = Math.max(1e-9, sMax-sMin), nr = Math.max(1e-9, nMax-nMin);
  const val = j => 0.55*(a.stepRaw[j]-sMin)/sr + 0.45*(a.novRaw[j]-nMin)/nr;

  const cur = val(i);
  let bi = i, bv = cur;
  for (let j=lo;j<=hi;j++){
    const v = val(j);
    if (v > bv){ bv = v; bi = j; }
  }
  // 窓内で相対的に良いだけでなく、実際に意味のある差があるときだけ動かす
  const realGain = (a.stepRaw[bi] - a.stepRaw[i] >= 0.8) || (a.nNov[bi] - a.nNov[i] >= 0.10);
  return (bv > cur + 0.05 && realGain) ? bi : i;
}

function clipLength(){
  const seg = $("segLen").querySelector("button.on");
  const v = parseFloat(seg.dataset.len);
  if (v === -1) return Math.max(1, parseFloat($("customLen").value) || 30);
  if (v === 0)  return 0;   // 最後まで
  return v;
}

function buildPicks(){
  const a = analysis;
  const want = clamp(parseInt($("count").value) || 8, 2, 20);
  const clip = clipLength();
  const minNeed = clip === 0 ? 8 : Math.min(clip*0.6, 20);
  const fr = a.featRate;

  const score = new Float32Array(a.nAgg);
  for (let i=0;i<a.nAgg;i++){
    score[i] = 0.30*a.nNov[i] + 0.26*a.nRise[i] + 0.24*a.nDrop[i] + 0.20*a.nEng[i];
  }

  const cand = [];
  for (let i=1;i<a.nAgg-1;i++){
    const t = i/fr;
    if (t < 0.8) continue;
    if (t > a.dur - minNeed) continue;
    // 局所ピークだけ拾う
    if (score[i] < score[i-1] || score[i] < score[i+1]) continue;
    cand.push({ i, t, s: score[i] });
  }
  cand.sort((x,y) => y.s - x.s);

  const gap = clamp(a.dur/(want*2.0), 4, 20);
  const chosen = [];
  for (const c of cand){
    if (chosen.length >= want) break;
    if (chosen.every(o => Math.abs(o.t - c.t) >= gap)) chosen.push(c);
  }
  // 足りなければ等間隔で埋める
  if (chosen.length < want){
    const usable = a.dur - minNeed;
    for (let k=0; k<want*2 && chosen.length<want; k++){
      const t = 1 + (usable-1)*(k+0.5)/want;
      if (t <= 0.8 || t > usable) continue;
      if (!chosen.every(o => Math.abs(o.t - t) >= gap*0.7)) continue;
      const i = clamp(Math.round(t*fr), 0, a.nAgg-1);
      chosen.push({ i, t, s: score[i], filler:true });
    }
  }

  chosen.sort((x,y) => x.t - y.t);

  picks = chosen.map((c, n) => {
    const i = c.filler ? c.i : refinePos(c.i);
    const t = clamp(snapTime(i/fr), 0, Math.max(0, a.dur-0.5));
    const end = clip === 0 ? a.dur : Math.min(a.dur, t + clip);
    // ラベルは正規化値ではなく実測dBのしきい値で決める（曲によらず意味が一定になる）
    const dDb = a.dropDb[i], rDb = a.riseDb[i], nv = a.nNov[i];
    let kind, cls;
    if (c.filler){
      kind = "均等割り"; cls = "t-even";
    } else if (dDb >= 4.0){
      kind = "ドロップ"; cls = "t-drop";
    } else if (rDb >= 2.0){
      kind = "盛り上がり開始"; cls = "t-rise";
    } else if (nv >= 0.45){
      kind = "展開の切り替わり"; cls = "t-switch";
    } else {
      kind = "区切り"; cls = "t-even";
    }
    return {
      n: n+1, t, end, kind, cls,
      hot: a.nEng[i] > 0.72,
      score: clamp(Math.max(c.s, score[i])/0.85, 0, 1)
    };
  });

  renderAll();
}

/* ============================ ループ探索 ============================ */
/* 「一周して先頭に戻っても違和感がない区間」を探す。
   終点eの直前と始点sの直前が似ていれば、e→s と繋いだとき耳が切れ目に気づかない。 */

function loopBars(){
  const b = $("segBars").querySelector("button.on");
  return parseInt(b.dataset.bars);   // 0 = おまかせ
}

/* 継ぎ目の直前どうしが似ていること（＝繋いだ瞬間に段差がない）に加えて、
   直後どうしも似ていること（＝2点が曲の中で同じ位置づけ）を見る。
   後者を入れないと、サビ頭のように「手前だけ雰囲気が違う」点を取りこぼす。 */
function seamSim(s, e){
  const a = analysis;
  if (!a) return -1;
  const W = Math.max(4, Math.round(a.featRate*1.5));
  const D = a.D, feat = a.feat;
  const ia = Math.round(s*a.featRate), ib = Math.round(e*a.featRate);
  if (ia < 0 || ib >= a.nAgg) return -1;
  const dot = (pa, pb) => {
    let d = 0;
    for (let m=0;m<D;m++) d += feat[pa*D+m]*feat[pb*D+m];
    return d;
  };
  let before = 0, nb = 0, after = 0, na = 0;
  for (let k=1;k<=W;k++){
    if (ia-k >= 0 && ib-k >= 0){ before += dot(ia-k, ib-k); nb++; }
  }
  for (let k=0;k<W;k++){
    if (ia+k < a.nAgg && ib+k < a.nAgg){ after += dot(ia+k, ib+k); na++; }
  }
  if (nb < W*0.5 || na < W*0.5) return -1;
  return (before/nb)*0.6 + (after/na)*0.4;
}

function seamScore(s, e){
  const a = analysis;
  const sim = seamSim(s, e);
  if (sim < 0) return 0;
  const ia = clamp(Math.round(s*a.featRate), 0, a.nAgg-1);
  const ib = clamp(Math.round(e*a.featRate), 0, a.nAgg-1);
  const dl = Math.abs(a.db[ia] - a.db[ib]);
  return sim*0.78 + Math.max(0, 1 - dl/12)*0.22;
}

/** ドラッグで動かしたループの継ぎ目を測り直す */
function rescoreLoop(idx){
  const lp = loops[idx];
  if (!lp) return;
  lp.score = clamp(seamScore(lp.t, lp.end), 0, 1);
}

function buildLoops(){
  const a = analysis;
  if (!a){ loops = []; renderLoops(); return; }

  // 小節頭のグリッド。取れなければ拍で代用する
  const grid = (a.downbeats.length >= 5) ? a.downbeats : a.beats;
  const isBarGrid = a.downbeats.length >= 5;
  if (grid.length < 3){ loops = []; renderLoops(); return; }

  const sel = loopBars();
  // グリッド1目盛りが1小節でないときは、4拍=1小節として換算する
  const stepsPerBar = isBarGrid ? 1 : 4;
  const barList = sel ? [sel] : [4, 8, 16];

  const dur = a.dur;
  const cand = [];
  for (const bars of barList){
    const stepCount = bars*stepsPerBar;
    for (let i=0; i+stepCount < grid.length; i++){
      const s = grid[i], e = grid[i+stepCount];
      const len = e - s;
      if (len < 2 || len > 45) continue;
      if (e > dur - 0.05) continue;
      if (seamSim(s, e) < 0) continue;
      cand.push({ s, e, len, bars, score: seamScore(s, e) });
    }
  }
  if (!cand.length){ loops = []; renderLoops(); return; }

  cand.sort((x,y) => y.score - x.score);

  // 似た場所ばかり並ばないように間引く
  const want = clamp(parseInt($("loopCount").value) || 6, 2, 20);
  const gap = Math.max(2, Math.min(10, dur/40));
  const chosen = [];
  for (const c of cand){
    if (chosen.length >= want) break;
    if (chosen.every(o => Math.abs(o.s - c.s) >= gap || o.bars !== c.bars)) chosen.push(c);
  }
  chosen.sort((x,y) => x.s - y.s);

  // スコアを見やすい0〜1に均す
  const lo = Math.min(...chosen.map(c=>c.score)), hi = Math.max(...chosen.map(c=>c.score));
  loops = chosen.map((c, n) => ({
    n: n+1, t: c.s, end: c.e, len: c.len, bars: c.bars,
    score: hi > lo ? (c.score-lo)/(hi-lo)*0.55 + 0.45 : 0.8,
    raw: c.score
  }));
  renderLoops();
}

/** ループ1周分を作る。継ぎ目は、eの先にある音を先頭に薄く重ねて滑らかにする */
function buildLoopBuffer(lp){
  const sr = origBuf.sampleRate;
  const s = Math.floor(lp.t*sr), e = Math.floor(lp.end*sr);
  const len = e - s;
  const nCh = origBuf.numberOfChannels;
  const smooth = $("xfade").checked;
  const x = smooth ? Math.min(Math.floor(sr*0.012), Math.floor(len/8), origBuf.length-e) : 0;

  const chans = [];
  for (let c=0;c<nCh;c++){
    const src = origBuf.getChannelData(c);
    const out = new Float32Array(len);
    out.set(src.subarray(s, e));
    for (let i=0;i<x;i++){
      const w = Math.sin(Math.PI/2 * i/x);          // 等パワークロスフェード
      out[i] = out[i]*w + src[e+i]*Math.cos(Math.PI/2 * i/x);
    }
    chans.push(out);
  }
  return { chans, sampleRate: sr, length: len };
}

/** 指定秒数になるまでループを繰り返して1本にする */
function repeatLoop(clip, seconds){
  const sr = clip.sampleRate, one = clip.length;
  const total = Math.max(one, Math.round(seconds*sr));
  const times = Math.ceil(total/one);
  const chans = clip.chans.map(src => {
    const out = new Float32Array(total);
    for (let r=0;r<times;r++){
      const off = r*one;
      const n = Math.min(one, total-off);
      if (n <= 0) break;
      out.set(src.subarray(0, n), off);
    }
    return out;
  });
  return { chans, sampleRate: sr, length: total };
}

async function loopClipFor(idx, onProg, fmt){
  const lp = loops[idx];
  let clip = buildLoopBuffer(lp);
  const rep = $("segRepeat").querySelector("button.on").dataset.rep === "0";
  if (rep) clip = repeatLoop(clip, Math.max(5, parseFloat($("repeatSec").value) || 60));
  const base = safeName(fileName.replace(/\.[^.]+$/, ""));
  const enc = await encodeAudio(clip, onProg, fmt);
  const name = base + "_loop" + String(lp.n).padStart(2,"0") + "_" +
               fmtTag(lp.t) + "_" + lp.bars + "bars" + (rep ? "_repeat" : "") + "." + enc.ext;
  return { blob: enc.blob, name, base };
}

/* ============================ 描画 ============================ */
function computePeaks(width){
  const ch = origBuf.getChannelData(0);
  const ch2 = origBuf.numberOfChannels > 1 ? origBuf.getChannelData(1) : null;
  const step = ch.length/width;
  const out = new Float32Array(width);
  for (let x=0;x<width;x++){
    const s = Math.floor(x*step), e = Math.min(ch.length, Math.floor((x+1)*step));
    let m = 0;
    for (let i=s;i<e;i+=4){
      let v = Math.abs(ch[i]);
      if (ch2) v = Math.max(v, Math.abs(ch2[i]));
      if (v > m) m = v;
    }
    out[x] = m;
  }
  return out;
}

function drawWave(){
  const cv = $("wave");
  const dpr = window.devicePixelRatio || 1;
  // 高さはCSS任せ（画面幅で変わるので固定値を書き込まない）
  const w = cv.clientWidth, h = cv.clientHeight || 150;
  cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,h);

  if (!peaks || peaks.length !== w) peaks = computePeaks(w);

  const mid = h*0.62, amp = h*0.34;
  g.fillStyle = "#39415a";
  for (let x=0;x<w;x++){
    const v = peaks[x]*amp;
    g.fillRect(x, mid-v, 1, Math.max(1, v*2));
  }

  const dur = origBuf.duration;

  // ドラッグ中は吸着先の目安として拍のグリッドを薄く出す
  if (drag && analysis && analysis.beats.length){
    g.fillStyle = "rgba(255,255,255,.07)";
    for (const b of analysis.beats) g.fillRect(b/dur*w, h-14, 1, 8);
    g.fillStyle = "rgba(255,255,255,.20)";
    for (const b of analysis.downbeats) g.fillRect(b/dur*w, h-18, 1, 12);
  }

  const items = mode === "loop" ? loops : picks;
  items.forEach((p, idx) => {
    const on = (idx === playing && playingMode === mode);
    const x = p.t/dur*w;
    const xe = p.end/dur*w;
    g.fillStyle = on ? "rgba(91,140,255,.22)" : "rgba(91,140,255,.09)";
    g.fillRect(x, 6, Math.max(1, xe-x), h-6);
    g.fillStyle = on ? "#ff7a59" : "#5b8cff";
    g.fillRect(x, 6, 2, h-6);
    if (mode === "loop") g.fillRect(Math.max(x+2, xe-2), 6, 2, h-6);

    // つまみ（両端）。狙っているものは明るくする
    const hot = (k) => (drag && drag.idx === idx && drag.kind === k) ||
                       (!drag && hoverHandle && hoverHandle.idx === idx && hoverHandle.kind === k);
    const grip = (gx, k) => {
      g.fillStyle = hot(k) ? "#ff7a59" : "rgba(91,140,255,.85)";
      g.fillRect(gx-3, h-30, 6, 24);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.fillRect(gx-1, h-25, 1, 14);
    };
    grip(x, "start");
    grip(xe, "end");
    // 番号バッジ
    g.beginPath();
    g.arc(clamp(x+11, 12, w-12), 17, 10, 0, Math.PI*2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 11px sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(p.n), clamp(x+11, 12, w-12), 17);
  });
}

function renderMeta(){
  $("mName").textContent = fileName;
  $("mDur").textContent  = fmtTime(origBuf.duration);
  $("mBpm").textContent  = analysis.bpm ? analysis.bpm.toFixed(1) : "不明";
  $("mCntLabel").textContent = mode === "loop" ? "ループ候補" : "検出点";
  $("mCnt").textContent = (mode === "loop" ? loops.length : picks.length) + " 件";
}

function renderLoops(){
  if (!origBuf) return;
  renderMeta();
  const tb = $("loopRows");
  tb.innerHTML = "";
  if (!loops.length){
    tb.innerHTML = '<tr><td colspan="5" style="color:var(--muted);padding:18px 10px">' +
      'この長さでは、繋いで自然になる区間が見つかりませんでした。小節数を変えるか「おまかせ」を試してください。</td></tr>';
    drawWave();
    return;
  }
  loops.forEach((p, idx) => {
    const on = (idx === playing && playingMode === "loop");
    const tr = document.createElement("tr");
    if (on) tr.className = "playing";
    tr.innerHTML =
      '<td><span class="num">' + p.n + '</span></td>' +
      '<td><div class="time">' + fmtTime(p.t) + ' → ' + fmtTime(p.end) + '</div></td>' +
      '<td><span class="tag t-switch">' + p.bars + '小節</span>' +
        '<span class="len" style="margin-left:8px">' + p.len.toFixed(1) + '秒</span>' +
        (p.edited ? '<span class="edited">手動調整</span>' : '') + '</td>' +
      '<td><div class="score"><div style="width:' + (p.score*100).toFixed(0) + '%"></div></div></td>' +
      '<td><div class="acts">' +
        '<button class="icon" data-lplay="' + idx + '">' + (on ? '■ 停止' : '▶ ループ再生') + '</button>' +
        '<button class="icon" data-ldl="' + idx + '" data-fmt="mp3">⬇ MP3</button>' +
        '<button class="icon" data-ldl="' + idx + '" data-fmt="wav">⬇ WAV</button>' +
      '</div></td>';
    tb.appendChild(tr);
  });
  drawWave();
}

function renderAll(){
  renderMeta();

  const tb = $("rows");
  tb.innerHTML = "";
  picks.forEach((p, idx) => {
    const tr = document.createElement("tr");
    if (idx === playing) tr.className = "playing";
    tr.innerHTML =
      '<td><span class="num">' + p.n + '</span></td>' +
      '<td><div class="time">' + fmtTime(p.t) + '</div>' +
        '<div class="len">' + (p.end-p.t).toFixed(1) + '秒</div></td>' +
      '<td><span class="tag ' + p.cls + '">' + p.kind + '</span>' +
        (p.hot ? '<span class="fire">🔥高エネルギー</span>' : '') +
        (p.edited ? '<span class="edited">手動調整</span>' : '') + '</td>' +
      '<td><div class="score"><div style="width:' + (p.score*100).toFixed(0) + '%"></div></div></td>' +
      '<td><div class="acts">' +
        '<button class="icon" data-play="' + idx + '">' + (idx===playing ? '■ 停止' : '▶ 試聴') + '</button>' +
        '<button class="icon" data-dl="' + idx + '" data-fmt="mp3">⬇ MP3</button>' +
        '<button class="icon" data-dl="' + idx + '" data-fmt="wav">⬇ WAV</button>' +
      '</div></td>';
    tb.appendChild(tr);
  });
  drawWave();
}

/* ============================ 再生 ============================ */
function stopPlay(){
  if (srcNode){ try{ srcNode.stop(); }catch(e){} srcNode = null; }
  playing = -1; playingMode = mode;
}
function play(idx){
  if (playing === idx){ stopPlay(); renderAll(); return; }
  stopPlay();
  const p = picks[idx];
  const fo = Math.max(0, parseFloat($("fadeOut").value) || 0);
  const len = p.end - p.t;
  const g = ac.createGain();
  const s = ac.createBufferSource();
  s.buffer = origBuf;
  s.connect(g); g.connect(ac.destination);
  const now = ac.currentTime + 0.02;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(1, now + 0.02);
  if (fo > 0 && fo < len){
    g.gain.setValueAtTime(1, now + len - fo);
    g.gain.linearRampToValueAtTime(0, now + len);
  }
  s.start(now, p.t, len);
  s.onended = () => { if (playing === idx && playingMode === "cut"){ playing = -1; renderAll(); } };
  srcNode = s;
  playing = idx; playingMode = "cut";
  renderAll();
}

/** ループ候補を実際にループ再生して継ぎ目を耳で確かめる */
function playLoop(idx){
  if (playing === idx && playingMode === "loop"){ stopPlay(); renderLoops(); return; }
  stopPlay();
  const p = loops[idx];
  const s = ac.createBufferSource();
  s.buffer = origBuf;
  s.loop = true;
  s.loopStart = p.t;
  s.loopEnd = p.end;
  s.connect(ac.destination);
  s.start(ac.currentTime + 0.02, p.t);
  srcNode = s;
  playing = idx; playingMode = "loop";
  renderLoops();
}

async function downloadLoop(idx, fmt){
  try{
    const c = await loopClipFor(idx, null, fmt);
    const sub = (dirHandle && $("subdir").checked) ? c.base : null;
    await saveBlob(c.blob, c.name, sub);
  }catch(e){
    $("err").textContent = "保存に失敗しました: " + (e && e.message ? e.message : e);
  }
}

async function downloadAllLoops(){
  const btn = $("dlAllLoops");
  btn.disabled = true;
  $("err").textContent = "";
  const sub = (dirHandle && $("subdir").checked) ? safeName(fileName.replace(/\.[^.]+$/, "")) : null;
  try{
    for (let i=0;i<loops.length;i++){
      const c = await loopClipFor(i, p => {
        btn.textContent = "書き出し中… " + (i+1) + "/" + loops.length + "（" + Math.round(p*100) + "%）";
      });
      btn.textContent = "書き出し中… " + (i+1) + "/" + loops.length;
      const wrote = await saveBlob(c.blob, c.name, sub);
      if (!wrote) await new Promise(r => setTimeout(r, 450));
    }
    btn.textContent = dirHandle ? "保存しました ✓" : bulkLabel();
  }catch(e){
    $("err").textContent = "保存に失敗しました: " + (e && e.message ? e.message : e);
    btn.textContent = bulkLabel();
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = bulkLabel(); }, 2500);
}

function setMode(m){
  mode = m;
  stopPlay();
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("cutPanel").classList.toggle("hidden", m !== "cut");
  $("loopPanel").classList.toggle("hidden", m !== "loop");
  $("cutResults").style.display  = m === "cut"  ? "" : "none";
  $("loopResults").style.display = m === "loop" ? "" : "none";
  if (!analysis) return;
  if (m === "loop") renderLoops(); else renderAll();
}

/* ============================ 書き出し ============================ */
function sliceWithFades(buf, start, end, fadeIn, fadeOut){
  const sr = buf.sampleRate;
  const s = clamp(Math.floor(start*sr), 0, buf.length-1);
  const e = clamp(Math.floor(end*sr), s+1, buf.length);
  const len = e - s;
  const nIn  = Math.min(len, Math.floor(fadeIn*sr));
  const nOut = Math.min(len, Math.floor(fadeOut*sr));
  const chans = [];
  for (let c=0;c<buf.numberOfChannels;c++){
    const src = buf.getChannelData(c);
    const out = new Float32Array(len);
    out.set(src.subarray(s, e));
    for (let i=0;i<nIn;i++)  out[i] *= 0.5 - 0.5*Math.cos(Math.PI*i/nIn);
    for (let i=0;i<nOut;i++) out[len-1-i] *= 0.5 - 0.5*Math.cos(Math.PI*i/nOut);
    chans.push(out);
  }
  return { chans, sampleRate: sr, length: len };
}

function encodeWav(clip){
  const nCh = clip.chans.length, len = clip.length, sr = clip.sampleRate;
  const bytes = 44 + len*nCh*2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const str = (o,t) => { for (let i=0;i<t.length;i++) dv.setUint8(o+i, t.charCodeAt(i)); };
  str(0,"RIFF"); dv.setUint32(4, bytes-8, true); str(8,"WAVE");
  str(12,"fmt "); dv.setUint32(16,16,true); dv.setUint16(20,1,true);
  dv.setUint16(22,nCh,true); dv.setUint32(24,sr,true);
  dv.setUint32(28, sr*nCh*2, true); dv.setUint16(32, nCh*2, true); dv.setUint16(34,16,true);
  str(36,"data"); dv.setUint32(40, len*nCh*2, true);
  let o = 44;
  for (let i=0;i<len;i++){
    for (let c=0;c<nCh;c++){
      let v = clip.chans[c][i];
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      dv.setInt16(o, v < 0 ? v*0x8000 : v*0x7FFF, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

function safeName(s){ return s.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/,"").slice(0, 60) || "audio"; }

/* ---- MP3書き出し（lamejs / LGPL-3.0） ---- */
/** まとめてダウンロードのボタンに、いま選ばれている形式を出す */
function bulkLabel(){
  return "全部まとめてダウンロード（" + (outFormat() === "mp3" ? "MP3" : "WAV") + "）";
}
function updateBulkLabels(){
  const a = $("dlAll"), b = $("dlAllLoops");
  if (a && !a.disabled) a.textContent = bulkLabel();
  if (b && !b.disabled) b.textContent = bulkLabel();
}

function outFormat(){ return $("segFmt").querySelector("button.on").dataset.fmt; }
function outKbps(){ return parseInt($("segKbps").querySelector("button.on").dataset.kbps) || 192; }

function toInt16(f32){
  const out = new Int16Array(f32.length);
  for (let i=0;i<f32.length;i++){
    let v = f32[i];
    v = v < -1 ? -1 : (v > 1 ? 1 : v);
    out[i] = v < 0 ? v*0x8000 : v*0x7FFF;
  }
  return out;
}

async function encodeMp3(clip, kbps, onProg){
  if (typeof lamejs === "undefined") throw new Error("MP3エンコーダを読み込めませんでした");
  const nCh = Math.min(2, clip.chans.length);
  const enc = new lamejs.Mp3Encoder(nCh, clip.sampleRate, kbps);
  const l = toInt16(clip.chans[0]);
  const r = nCh > 1 ? toInt16(clip.chans[1]) : null;
  const BLOCK = 1152;
  const parts = [];
  for (let i=0;i<l.length;i+=BLOCK){
    const ls = l.subarray(i, i+BLOCK);
    const buf = r ? enc.encodeBuffer(ls, r.subarray(i, i+BLOCK)) : enc.encodeBuffer(ls);
    if (buf.length) parts.push(new Int8Array(buf));
    if ((i/BLOCK & 63) === 0){
      if (onProg) onProg(i/l.length);
      await tick();
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Int8Array(end));
  return new Blob(parts, { type: "audio/mpeg" });
}

/** 選ばれている形式で書き出す。戻り値は {blob, ext} */
async function encodeAudio(clip, onProg, fmt){
  if ((fmt || outFormat()) === "mp3"){
    return { blob: await encodeMp3(clip, outKbps(), onProg), ext: "mp3" };
  }
  return { blob: encodeWav(clip), ext: "wav" };
}

/* ---- 保存先フォルダ（File System Access API） ---- */
let dirHandle = null;

// 選んだフォルダを次回も覚えておくための最小限のIndexedDB
function idbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open("hookfinder", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v){
  try{
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(v, k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }catch(e){ /* 使えない環境なら諦める */ }
}
async function idbGet(k){
  try{
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const t = db.transaction("kv", "readonly");
      const q = t.objectStore("kv").get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }catch(e){ return undefined; }
}

async function hasPerm(h, ask){
  if (!h.queryPermission) return true;
  const opt = { mode:"readwrite" };
  if (await h.queryPermission(opt) === "granted") return true;
  if (!ask) return false;
  return await h.requestPermission(opt) === "granted";
}

function showDirNote(html){
  const n = $("dirNote");
  n.innerHTML = html;
  n.classList.toggle("hidden", !html);
}

function setDirLabel(){
  const el = $("dirName");
  if (dirHandle){
    el.textContent = dirHandle.name + " に保存";
    el.classList.add("set");
    $("clearDir").classList.remove("hidden");
    $("pickDir").textContent = "変更";
  } else {
    el.textContent = "ブラウザの既定のダウンロードフォルダ";
    el.classList.remove("set");
    $("clearDir").classList.add("hidden");
    $("pickDir").textContent = "フォルダを選ぶ";
  }
}

async function pickDir(){
  if (!window.showDirectoryPicker){
    showDirNote("このブラウザは保存先の指定に対応していません（Chrome / Edge のデスクトップ版が必要です）。既定のダウンロードフォルダに保存されます。");
    return;
  }
  try{
    dirHandle = await window.showDirectoryPicker({ mode:"readwrite", id:"hookfinder" });
    await idbSet("dir", dirHandle);
    showDirNote("");
    setDirLabel();
  }catch(e){
    if (e && e.name === "AbortError") return;   // ユーザーがキャンセルしただけ
    if (location.protocol !== "http:" && location.protocol !== "https:"){
      showDirNote(
        "<b>この開き方では保存先を指定できません。</b>ブラウザの仕様で、<code>file://</code> で直接開いたページはフォルダ選択が禁止されています。" +
        "<br>同じフォルダの <code>起動.bat</code> をダブルクリックして <code>http://localhost:8899/</code> から開くと使えるようになります。" +
        "<br>このままでも書き出しはできます（ブラウザの既定のダウンロードフォルダに保存されます）。"
      );
    } else {
      showDirNote("フォルダを開けませんでした: " + (e && e.message ? e.message : e));
    }
    dirHandle = null;
    setDirLabel();
  }
}

/** 保存先が指定されていればそこへ書き込み、無ければ通常のダウンロード */
async function saveBlob(blob, name, sub){
  if (dirHandle){
    if (await hasPerm(dirHandle, true)){
      let target = dirHandle;
      if (sub) target = await dirHandle.getDirectoryHandle(sub, { create:true });
      const fh = await target.getFileHandle(name, { create:true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    }
    // 権限が下りなければ通常ダウンロードに落とす
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return false;
}

async function clipBlobFor(idx, onProg, fmt){
  const p = picks[idx];
  const fo = Math.max(0, parseFloat($("fadeOut").value) || 0);
  const base = safeName(fileName.replace(/\.[^.]+$/, ""));
  const enc = await encodeAudio(sliceWithFades(origBuf, p.t, p.end, 0.02, fo), onProg, fmt);
  const name = base + "_" + String(p.n).padStart(2,"0") + "_" + fmtTag(p.t) + "_" + p.kind + "." + enc.ext;
  return { blob: enc.blob, name, base };
}

async function download(idx, fmt){
  const c = await clipBlobFor(idx, null, fmt);
  const sub = (dirHandle && $("subdir").checked) ? c.base : null;
  try{
    await saveBlob(c.blob, c.name, sub);
  }catch(e){
    $("err").textContent = "保存に失敗しました: " + (e && e.message ? e.message : e);
  }
}

async function downloadAll(){
  const btn = $("dlAll");
  btn.disabled = true;
  $("err").textContent = "";
  const sub = (dirHandle && $("subdir").checked) ? safeName(fileName.replace(/\.[^.]+$/, "")) : null;
  try{
    for (let i=0;i<picks.length;i++){
      const c = await clipBlobFor(i, p => {
        btn.textContent = "書き出し中… " + (i+1) + "/" + picks.length + "（" + Math.round(p*100) + "%）";
      });
      btn.textContent = "書き出し中… " + (i+1) + "/" + picks.length;
      const wrote = await saveBlob(c.blob, c.name, sub);
      // 通常ダウンロードは連続で弾かれることがあるので少し間を空ける
      if (!wrote) await new Promise(r => setTimeout(r, 450));
    }
    btn.textContent = dirHandle ? "保存しました ✓" : bulkLabel();
  }catch(e){
    $("err").textContent = "保存に失敗しました: " + (e && e.message ? e.message : e);
    btn.textContent = bulkLabel();
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = bulkLabel(); }, 2500);
}

/** 前回選んだフォルダを復元（権限は保存時に聞く）
 *  保存先の指定に対応していないブラウザでは、その欄ごと出さない */
(async function restoreDir(){
  if (!window.showDirectoryPicker){
    $("dirRow").classList.add("hidden");
    $("dirDivider").classList.add("hidden");
    return;
  }
  const h = await idbGet("dir");
  if (h && h.kind === "directory"){ dirHandle = h; setDirLabel(); }
})();

/* ============================ 読み込み ============================ */
async function loadFile(f){
  $("err").textContent = "";
  stopPlay();
  try{
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") await ac.resume();
    if (f.size > 250*1024*1024){
      $("err").textContent = "ファイルが大きすぎます（" + (f.size/1024/1024).toFixed(0) + "MB）。250MB以下にしてください。";
      return;
    }
    fileName = f.name;
    $("prog").style.display = "block";
    $("progTxt").textContent = "ファイルを読み込み中…";
    $("progBar").style.width = "2%";
    const ab = await f.arrayBuffer();
    origBuf = await ac.decodeAudioData(ab);
    if (origBuf.duration < 5){
      $("prog").style.display = "none";
      $("err").textContent = "曲が短すぎます（" + origBuf.duration.toFixed(1) + "秒）。5秒以上の音源を読み込ませてください。";
      return;
    }
    peaks = null;
    $("main").classList.remove("hidden");
    await runAnalysis();
  } catch(e){
    $("prog").style.display = "none";
    $("err").textContent = "読み込みか解析に失敗しました: " + (e && e.message ? e.message : e);
    console.error(e);
  }
}

/* ============================ イベント ============================ */
const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
  e.preventDefault(); drop.classList.remove("over");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
$("file").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

$("segLen").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("segLen").querySelectorAll("button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  $("customWrap").classList.toggle("hidden", b.dataset.len !== "-1");
  if (analysis){ stopPlay(); buildPicks(); }
});
["customLen","count","fadeOut"].forEach(id =>
  $(id).addEventListener("change", () => { if (analysis){ stopPlay(); buildPicks(); } })
);
$("snap").addEventListener("change", () => { if (analysis){ stopPlay(); buildPicks(); } });
$("redo").addEventListener("click", () => { if (origBuf){ stopPlay(); runAnalysis(); } });
$("dlAll").addEventListener("click", downloadAll);
$("pickDir").addEventListener("click", pickDir);
$("clearDir").addEventListener("click", async () => {
  dirHandle = null;
  await idbSet("dir", null);
  showDirNote("");
  setDirLabel();
});

document.querySelector(".tabs").addEventListener("click", e => {
  const b = e.target.closest(".tab");
  if (b) setMode(b.dataset.mode);
});
$("segFmt").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("segFmt").querySelectorAll("button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  updateBulkLabels();
});
$("segKbps").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("segKbps").querySelectorAll("button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
});
$("segBars").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("segBars").querySelectorAll("button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  if (analysis){ stopPlay(); buildLoops(); }
});
$("segRepeat").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  $("segRepeat").querySelectorAll("button").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  $("repeatWrap").classList.toggle("hidden", b.dataset.rep !== "0");
});
$("loopCount").addEventListener("change", () => { if (analysis){ stopPlay(); buildLoops(); } });
$("dlAllLoops").addEventListener("click", downloadAllLoops);
$("loopRows").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.lplay !== undefined) playLoop(parseInt(b.dataset.lplay));
  if (b.dataset.ldl   !== undefined) downloadLoop(parseInt(b.dataset.ldl), b.dataset.fmt);
});

$("rows").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.play !== undefined) play(parseInt(b.dataset.play));
  if (b.dataset.dl !== undefined)   download(parseInt(b.dataset.dl), b.dataset.fmt);
});

/* ============================ 波形のドラッグ編集 ============================ */
/* 端をつまんで動かせる。動かしている間は拍・小節頭・検出した境目に吸い付く。
   Shiftを押しながらだと吸着なしで細かく詰められる。 */

let drag = null;          // { idx, kind:"start"|"end"|"move", grabT }
let hoverHandle = null;   // { idx, kind }

const HANDLE_PX = 9;      // つまめる幅

function curItems(){ return mode === "loop" ? loops : picks; }

function waveTimeAt(clientX){
  const cv = $("wave");
  const r = cv.getBoundingClientRect();
  return clamp((clientX - r.left)/r.width*origBuf.duration, 0, origBuf.duration);
}

/** ドラッグ中の吸着先。近い順に 小節頭 → 拍 → 検出した境目 */
function snapDrag(t, noSnap){
  if (noSnap || !analysis) return t;
  const a = analysis;
  const tolPx = 10;
  const cv = $("wave");
  const tol = (tolPx / Math.max(1, cv.clientWidth)) * origBuf.duration;

  let best = null, bd = Infinity, kind = null;
  const consider = (v, k) => { const d = Math.abs(v - t); if (d < bd){ bd = d; best = v; kind = k; } };

  for (const v of a.downbeats) consider(v, "bar");
  if (bd > tol) for (const v of a.beats) consider(v, "beat");
  // 検出済みの構成の切れ目にも吸わせる
  for (const p of picks) consider(p.t, "section");

  return bd <= tol ? best : t;
}

function handleHitTest(clientX){
  const cv = $("wave");
  const r = cv.getBoundingClientRect();
  const dur = origBuf.duration;
  const items = curItems();
  const px = t => t/dur*r.width;
  const x = clientX - r.left;
  for (let i=0;i<items.length;i++){
    if (Math.abs(px(items[i].t)   - x) <= HANDLE_PX) return { idx:i, kind:"start" };
    if (Math.abs(px(items[i].end) - x) <= HANDLE_PX) return { idx:i, kind:"end" };
  }
  for (let i=0;i<items.length;i++){
    if (x > px(items[i].t) && x < px(items[i].end)) return { idx:i, kind:"move" };
  }
  return null;
}

/** ドラッグ結果を反映。ループは長さを保ったまま動かす */
function applyDrag(t, noSnap){
  const items = curItems();
  const it = items[drag.idx];
  const dur = origBuf.duration;
  const minLen = 0.4;
  const s = snapDrag(t, noSnap);

  if (drag.kind === "start"){
    if (mode === "loop"){
      const len = it.end - it.t;
      it.t = clamp(s, 0, dur - len);
      it.end = it.t + len;
    } else {
      it.t = clamp(s, 0, it.end - minLen);
    }
  } else if (drag.kind === "end"){
    it.end = clamp(s, it.t + minLen, dur);
  } else {
    const len = it.end - it.t;
    const ns = clamp(s - drag.grabT, 0, dur - len);
    it.t = ns; it.end = ns + len;
  }
  it.len = it.end - it.t;
  if (mode === "loop" && analysis && analysis.period){
    it.bars = Math.max(1, Math.round(it.len / (analysis.period*4)));
  }
  it.edited = true;
}

$("wave").addEventListener("pointermove", e => {
  if (!origBuf || !curItems().length) return;
  if (drag){
    applyDrag(waveTimeAt(e.clientX), e.shiftKey);
    if (mode === "loop") renderLoops(); else renderAll();
    return;
  }
  const h = handleHitTest(e.clientX);
  const cur = h ? (h.kind === "move" ? "grab" : "ew-resize") : "pointer";
  $("wave").style.cursor = cur;
  const changed = JSON.stringify(h) !== JSON.stringify(hoverHandle);
  hoverHandle = h;
  if (changed) drawWave();
});

$("wave").addEventListener("pointerdown", e => {
  if (!origBuf || !curItems().length) return;
  const h = handleHitTest(e.clientX);
  if (!h) return;
  e.preventDefault();
  stopPlay();
  drag = { idx:h.idx, kind:h.kind, grabT: waveTimeAt(e.clientX) - curItems()[h.idx].t };
  $("wave").setPointerCapture(e.pointerId);
});

function endDrag(e){
  if (!drag) return;
  const idx = drag.idx;
  drag = null;
  try{ $("wave").releasePointerCapture(e.pointerId); }catch(_){}
  if (mode === "loop"){
    // 動かしたループは継ぎ目の自然さを測り直す
    rescoreLoop(idx);
    renderLoops();
  } else renderAll();
}
$("wave").addEventListener("pointerup", endDrag);
$("wave").addEventListener("pointercancel", endDrag);

$("wave").addEventListener("click", e => {
  if (!curItems().length) return;
  if (handleHitTest(e.clientX)) return;   // つまみの上では再生しない
  const t = waveTimeAt(e.clientX);
  const items = curItems();
  let best = 0, bd = Infinity;
  items.forEach((p,i) => { const d = Math.abs(p.t - t); if (d < bd){ bd = d; best = i; } });
  if (mode === "loop") playLoop(best); else play(best);
});

window.addEventListener("resize", () => { if (origBuf){ peaks = null; drawWave(); } });
/* ページごとの初期モード（build.py が window.FLOMUSIC_PAGE を先に定義する） */
if (window.FLOMUSIC_PAGE && window.FLOMUSIC_PAGE.mode === "loop") setMode("loop");

updateBulkLabels();
