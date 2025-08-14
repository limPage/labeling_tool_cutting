import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

// --- helpers ---
const fmt = (s) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};
const LS_PREFIX = "wavseg:rows:";
const loadRowsLS = (key) => {
  try {
    const s = localStorage.getItem(LS_PREFIX + key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

const saveRowsLS = (key, rows) => {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(rows));
  } catch (e) {
    // 용량 초과 등은 무시(필요 시 사용자 알림)
    console.warn("localStorage save failed", e);
  }
};

const deleteRowsLS = (key) => {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {}
};

const COLORS = [
  "#22c55e55",
  "#3b82f655",
  "#ef444455",
  "#eab30855",
  "#a855f755",
  "#06b6d455",
  "#f9731655",
];

function baseName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

// WAV encoder (PCM16)
function audioBufferToWav(ab) {
  const numChannels = ab.numberOfChannels;
  const sampleRate = ab.sampleRate;
  const numFrames = ab.length;

  // interleave
  const interleaved = new Float32Array(numFrames * numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = ab.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      interleaved[i * numChannels + ch] = data[i];
    }
  }

  // convert to PCM16
  const buffer = new ArrayBuffer(44 + interleaved.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + interleaved.length * 2, true);
  writeString(8, "WAVE");

  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  const byteRate = sampleRate * numChannels * 2;
  view.setUint32(28, byteRate, true);
  view.setUint16(32, numChannels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data
  writeString(36, "data");
  view.setUint32(40, interleaved.length * 2, true);

  let offset = 44;
  for (let i = 0; i < interleaved.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

function sliceBuffer(ctx, ab, startSec, endSec) {
  const start = Math.max(0, Math.floor(startSec * ab.sampleRate));
  const end = Math.min(Math.floor(endSec * ab.sampleRate), ab.length);
  const frames = Math.max(0, end - start);
  const out = ctx.createBuffer(ab.numberOfChannels, frames, ab.sampleRate);
  for (let ch = 0; ch < ab.numberOfChannels; ch++) {
    const src = ab.getChannelData(ch).subarray(start, end);
    out.copyToChannel(src, ch, 0);
  }
  return out;
}

export default function App() {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionsRef = useRef(null);
  const acRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const [files, setFiles] = useState([]); // File[]
  const [current, setCurrent] = useState(0);
  const [audioBuffer, setAudioBuffer] = useState(null);
  const [duration, setDuration] = useState(0);
  const [rows, setRows] = useState([]); // {id,label,maxLen,start,end,color}

  const DEFAULT_MAX_LEN = 1.0;
  const MIN_LEN = 0.5;   // ★ 최소 0.5초
  const MAX_LEN = 5.0;
  const MAX_REGIONS = 7; // ★ 최대 구간 수
  const seedOnReadyRef = useRef(false);     // 이번 로드에서 기본 구간 1개 심기
  const rowsShadowRef = useRef(rows);       // region 드래그시 최신 rows 접근용
  const isRestoringRef = useRef(false); // ★ 복원 중 캐시 저장 막기
  const pendingRowsRef = useRef(null); // ready 때 그려줄 대기 rows
// 컴포넌트 상단
const fileKey = (f) => (f ? `${f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}` : "");
const fileRowsRef = useRef(new Map()); // key -> rows[]
const pickColor = (rowsArr) => {
  const used = new Set((rowsArr || []).map(r => r.color));
  return COLORS.find(c => !used.has(c)) || COLORS[0];
};

const ensureUniqueColors = (rowsArr) => {
  const used = new Set();
  return rowsArr.map(r => {
    let c = (r.color && COLORS.includes(r.color) && !used.has(r.color)) ? r.color : null;
    if (!c) c = COLORS.find(x => !used.has(x)) || COLORS[0];
    used.add(c);
    return { ...r, color: c };
  });
};

const updateRegionBadges = () => {
  const regions = regionsRef.current?.getRegions?.() || [];
  rows.forEach((r, idx) => {
    const reg = regions.find(x => x.id === r.id);
    if (!reg || !reg.element) return;
    let badge = reg.element.querySelector('.region-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className =
        'region-badge absolute bottom-1 left-1 text-[10px] leading-none px-1 rounded bg-black/40 text-white pointer-events-none select-none';
      reg.element.appendChild(badge);
    }
    badge.textContent = String(idx + 1);
  });
};
useEffect(() => { updateRegionBadges(); }, [rows]);

const persistCurrent = () => {
  const cur = files[current];
  if (!cur) return;
  const key = fileKey(cur);
  fileRowsRef.current.set(key, rows);
  saveRowsLS(key, rows);
};

  // 파일 상단 (컴포넌트 안)
  const clearAllRegions = () => {
  const regions = regionsRef.current;
  if (!regions) return;
  const arr = regions.getRegions();
  if (arr && arr.length) arr.forEach(r => r.remove());
  setRows([]);                 // React 상태도 동기 초기화
  };

  useEffect(() => {
    if (isRestoringRef.current) return; // ★ 복원 중엔 저장 금지
    const cur = files[current];
    if (!cur) return;
    const key = fileKey(cur);
    fileRowsRef.current.set(key, rows);
    saveRowsLS(key, rows); 
}, [rows, current, files]);

  useEffect(() => { rowsShadowRef.current = rows; }, [rows]);

useEffect(() => {
  const onBeforeUnload = () => { persistCurrent(); };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
}, [files, current, rows]);

  useEffect(() => {
    if (folderInputRef.current) {
      // 폴더 선택 허용
      folderInputRef.current.setAttribute("webkitdirectory", "");
    }
  }, []);

  const renderRowsToRegions = (rowsToDraw) => {
    isRestoringRef.current = true; // ★
  const regions = regionsRef.current;
  if (!regions) return;
  clearAllRegions();
  // rowsToDraw.forEach((r) => {
 const normalized = ensureUniqueColors(rowsToDraw).slice(0, MAX_REGIONS); // ★ 유니크 보정
 normalized.forEach((r) => {
    
    regions.addRegion({
      id: r.id, start: r.start, end: Math.min(r.start + r.maxLen, r.end),
      color: r.color, drag: true, resize: false
    });
  });
  // setRows(rowsToDraw);
  setRows(normalized);
  requestAnimationFrame(() => { isRestoringRef.current = false; }); // ★
};

  // init wavesurfer (한 번만)
  useEffect(() => {
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 140,
      waveColor: "#cbd5e1",
      progressColor: "#3b82f6",
      cursorColor: "#64748b",
      normalize: true,
      minPxPerSec: 50,
    });
    // const regions = ws.registerPlugin(RegionsPlugin.create());
    const regions = ws.registerPlugin(RegionsPlugin.create({ dragSelection: false }));
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
  const d = ws.getDuration();
  setDuration(d);

 // 3-1) 캐시 복원을 ready 시점에 먼저 처리
 if (pendingRowsRef.current && pendingRowsRef.current.length) {
   const toDraw = pendingRowsRef.current;
   pendingRowsRef.current = null;
   isRestoringRef.current = true;
   renderRowsToRegions(toDraw);
   requestAnimationFrame(() => { isRestoringRef.current = false; });
   return; // 캐시 복원했으면 seed 스킵
 }

 const regions = regionsRef.current;
 const noRegions = !regions || regions.getRegions().length === 0;
 const noRows = rowsShadowRef.current.length === 0;
 if (seedOnReadyRef.current || (noRegions && noRows)) {
    seedOnReadyRef.current = false;
    isRestoringRef.current = true; // ★
    const id = Math.random().toString(36).slice(2);
    const color = COLORS[0];
    const start = 0;
    const end = Math.min(DEFAULT_MAX_LEN, d);
  //  setRows([{ id, label: "", maxLen: DEFAULT_MAX_LEN, start, end, color }]);
   const initial = [{ id, label: "", maxLen: DEFAULT_MAX_LEN, start, end, color }];
   renderRowsToRegions(initial);
   requestAnimationFrame(() => { isRestoringRef.current = false; }); // ★
  }
});


    ws.on("destroy", () => setDuration(0));

    // 사용자 드래그 시 React 상태와 동기화 + maxLen 강제
    regions.on("region-updated", (reg) => {
      const cur = rowsShadowRef.current;
      const meta = cur.find((r) => r.id === reg.id);
      const maxLen = meta ? meta.maxLen : DEFAULT_MAX_LEN;

      // cap end by start+maxLen
      if (reg.end > reg.start + maxLen){reg.setOptions({ start: reg.start, end: reg.start + maxLen });};

      setRows((prev) =>
        prev.map((r) =>
          r.id === reg.id
            ? { ...r, start: reg.start, end: Math.min(reg.start + r.maxLen, reg.end) }
            : r
        )
      );
    });

    return () => ws.destroy();
  }, []);

  const loadFile = async (file) => {
    isRestoringRef.current = true;        // ★ 캐시 저장 잠시 중지
  // 이전 상태 초기화
  clearAllRegions();
  // isPointerDownRef.current = false;
  wsRef.current?.stop?.();

  const url = URL.createObjectURL(file);
  if (window.__prevAudioUrl) URL.revokeObjectURL(window.__prevAudioUrl);
  window.__prevAudioUrl = url;

 // 캐시에 있으면 복원, 없으면 ready에서 기본 1구간 생성
 const key = fileKey(file);
let cached = fileRowsRef.current.get(key);
 if (!cached) cached = loadRowsLS(key); // ← 메모리에 없으면 localStorage에서
 const hasCached = Array.isArray(cached) && cached.length > 0;
 seedOnReadyRef.current = !hasCached;     // 캐시 없으면 기본 1구간 seed
 pendingRowsRef.current = hasCached ? cached : null; // 캐시 있으면 ready 때 그릴 것

  wsRef.current.load(url);

  if (!acRef.current) acRef.current = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await file.arrayBuffer();
  const decoded = await acRef.current.decodeAudioData(buf);
  setAudioBuffer(decoded);

// isRestoringRef는 ready에서 복원/seed가 끝난 뒤에 끕니다.
};


  // 현재 파일이 바뀌면 로드
  useEffect(() => {
    if (files[current]) loadFile(files[current]);
  }, [current, files]);

  const onPickFiles = (e) => {
    const picked = Array.from(e.target.files || []).filter((f) => /\.wav$/i.test(f.name));
    if (picked.length) {
      setFiles((prev) => {
        const next = [...prev, ...picked];
        if (prev.length === 0) setCurrent(0); // 최초 추가면 즉시 첫 파일 로드
        return next;
      });
    }
    e.target.value = "";
  };

  const onPickFolder = (e) => onPickFiles(e);

  const addRow = () => {
    // if (!wsRef.current) return;
    if (!wsRef.current || !canAddRegion) return; // 로드 전엔 막기
     if (rows.length >= MAX_REGIONS) {
       alert("구간은 최대 7개까지만 추가할 수 있어요.");
       return;
     }
    const id = Math.random().toString(36).slice(2);
    // const color = COLORS[rows.length % COLORS.length];
    const color = pickColor(rowsShadowRef.current); // ★ 현재 사용 중 아닌 색
    const start = 0;
    const end = Math.min(DEFAULT_MAX_LEN, wsRef.current.getDuration());
    regionsRef.current.addRegion({ id, start, end, color, drag: true, resize: false });
    setRows((prev) => [...prev, { id, label: "", maxLen: DEFAULT_MAX_LEN, start, end, color }]);
  };

  const updateRow = (id, patch) => {
  const dur = wsRef.current?.getDuration?.() || duration || Infinity;
  const curMeta = rowsShadowRef.current.find((r) => r.id === id);
  setRows(prev =>
    prev.map(r => {
      if (r.id !== id) return r;

      // 음원길이 + 1초 초과 불가
      const maxAllowed = Math.min(MAX_LEN, dur + 1);
      const maxLen = Math.min(maxAllowed, Math.max(MIN_LEN, patch.maxLen ?? r.maxLen));

      let start = patch.start ?? r.start;
      // start가 너무 뒤라 길이만큼 못 담으면 뒤로 못 가게
      const latestStart = Math.max(0, dur - maxLen);
      if (isFinite(dur)) start = Math.min(start, latestStart);
      const endCandidate = patch.end ?? r.end;
      const end = Math.min(start + maxLen, isFinite(dur) ? dur : endCandidate);
      return { ...r, ...patch, maxLen, start, end };
    })
  );
  // Wavesurfer region에 즉시 반영
  const reg = regionsRef.current.getRegions().find(x => x.id === id);
  if (reg) {
    const meta = rowsShadowRef.current.find(r => r.id === id) || curMeta;
    const maxLen = Math.min(MAX_LEN, Math.max(MIN_LEN, patch.maxLen ?? meta?.maxLen ?? DEFAULT_MAX_LEN));
    let start = patch.start ?? reg.start;
    const latestStart = Math.max(0, dur - maxLen);
    if (isFinite(dur)) start = Math.min(start, latestStart);
    const end = Math.min(start + maxLen, isFinite(dur) ? dur : (patch.end ?? reg.end));
    reg.setOptions({ start, end });
  }
  };


   const removeRow = (rowOrId) => {
       const id = typeof rowOrId === 'string' ? rowOrId : rowOrId?.id;
          if (!id) return;
   const region = regionsRef.current?.getRegions().find((x) => x.id === id);
   if (region) region.remove();
   setRows(prev => prev.filter(r => r.id !== id));
 };

  const playRegion = (r) => {
    if (!wsRef.current) return;
    wsRef.current.play(r.start, Math.min(r.start + r.maxLen, r.end));
  };

  const saveRow = async (r) => {
    if (!audioBuffer || !files[current]) return;
    const sliced = sliceBuffer(
      acRef.current,
      audioBuffer,
      r.start,
      Math.min(r.start + r.maxLen, r.end)
    );
    const blob = audioBufferToWav(sliced);
    const a = document.createElement("a");
    const base = baseName(files[current].name);
    const label = (r.label || "seg").replace(/\s+/g, "_");
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_${label}.wav`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const saveAll = async () => {
    for (const r of rows) await saveRow(r);
  };

  // const nextFile = () => {
  //   if (current < files.length - 1) setCurrent((c) => c + 1);
  // };
  const nextFile = () => {
  if (current < files.length - 1) {
   persistCurrent();
      isRestoringRef.current = true;
    setCurrent((c) => c + 1);
   requestAnimationFrame(() => {
     isRestoringRef.current = false;
   });
  }
};
const completeAndNext = () => {
  if (!files.length) return;

 const curKey = fileKey(files[current]);
 fileRowsRef.current.delete(curKey);
  deleteRowsLS(curKey);           // ← localStorage도 정리

isRestoringRef.current = true;
  // 목록에서 현재 파일 제거
  const nextFiles = files.filter((_, i) => i !== current);
  setFiles(nextFiles);
  // 다음 인덱스 정리
  if (nextFiles.length === 0) {
    setCurrent(0);
    clearAllRegions();
  } else {
    setCurrent(Math.min(current, nextFiles.length - 1));
  }
  requestAnimationFrame(() => { isRestoringRef.current = false; });
};

  const currentFile = files[current];
const canAddRegion = !!currentFile && duration > 0; // 음원 로드되어 ready 된 상태
  return (
    <div className="p-6 grid grid-cols-12 gap-4 min-h-screen bg-slate-50 containner-background">
      {/* Left: editor */}
      <div className="col-span-9 space-y-4 gray-background">
        <div className="border-b">
          <div className="p-4 space-y-3 ">
            <div className="flex items-center gap-2 flex-wrap">
              <img
                src="./hj_logo.png"   // public 폴더에 logo.png를 넣었다면 이렇게
                alt="로고"
                className="w-[130px] h-[50px] border rounded-lg border-gray-100"
              />

              {/* 숨긴 파일 입력들 */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".wav"
                multiple
                onChange={onPickFiles}
                style={{ display: "none" }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                onChange={onPickFolder}
                style={{ display: "none" }}
              />

              {/* 사용자 버튼 */}
              {/* <button onClick={() => fileInputRef.current?.click()}>파일 불러오기</button> */}
              {/* <button onClick={() => folderInputRef.current?.click()}>폴더 불러오기</button> */}

              <div className="pr-[140px] m-auto text-lg text-slate-800 ">
                {currentFile ? (
                  <span>
                    {currentFile.name} • {fmt(duration)}
                  </span>
                ) : (
                  <span>파일을 선택하세요</span>
                )}
              </div>
            </div>

            <div ref={containerRef} className="w-full rounded-xl overflow-hidden bg-white border" />

            {/* <div className="flex items-center gap-2">
              <button onClick={() => wsRef.current?.playPause()}>재생/일시정지</button>
              <button onClick={() => wsRef.current?.stop()}>정지</button>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={addRow}>구간 추가</button>
              </div>
            </div> */}

           <div className="grid grid-cols-[1fr_auto_1fr] items-center">
             <div /> {/* 좌측 빈 칸 */}
             <div className="flex justify-center gap-2">
               <button className="play-button" onClick={() => wsRef.current?.playPause()}>▶∥ </button>
               <button className="play-button" onClick={() => wsRef.current?.stop()}>■</button>
             </div>
             <div className="justify-self-end flex items-center gap-2">

   <button onClick={addRow} disabled={!canAddRegion} title={!canAddRegion ? "먼저 음원을 불러오세요" : ""}>
   구간 추가 </button>
             </div>
           </div>


          </div>
        </div>

        {/* Rows */}
        <div className="space-y-3">
          {rows.map((r, idx) => (
            <div key={r.id} className="shadow-sm">
              <div className="p-3 grid grid-cols-12 gap-3 items-center">
                <div className="col-span-1 text-center font-semibold">{idx + 1}</div>

                <div className="col-span-2 flex items-center gap-2">
                  <span className="text-sm text-slate-600">최대 길이</span>
                  <input
                    type="number"
                     min={MIN_LEN}
                     max={Math.min(MAX_LEN, duration + 1)}
                     step={0.1}
                    value={r.maxLen}
                    onChange={(e) =>
                      updateRow(r.id, {
                        maxLen: Math.min(MAX_LEN, Math.max(MIN_LEN, parseFloat(e.target.value) || DEFAULT_MAX_LEN)),
                      })
                    }
                    className="pl-4  w-[65px]"
                  />
                  <span className="text-sm text-slate-500">초</span>
                </div>

                <div className="col-span-3 flex items-center gap-2">
                  <span className="text-sm text-slate-600">라벨링</span>
                  <input className="pl-2"
                    placeholder="ex) 살려주세요"
                    value={r.label}
                    onChange={(e) => updateRow(r.id, { label: e.target.value })}
                  />
                </div>

                <div className="col-span-3 flex items-center gap-2 text-sm">
                  <span className="px-2 py-1 rounded" style={{ backgroundColor: r.color }}>
                    선택영역
                  </span>
                  <span>
                    {fmt(r.start)} ~ {fmt(Math.min(r.end, r.start + r.maxLen))}
                  </span>
                </div>

                <div className="col-span-3 flex gap-2 justify-end">
                  <button className="normal-button" onClick={() => playRegion(r)}>구간 재생</button>
                  <button className="normal-button" onClick={() => saveRow(r)}>저장</button>
                  <button className="normal-button"onClick={() => removeRow(r.id)}>삭제</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {rows.length > 0 && (
          <div className="flex items-center justify-between p-2">
            <button onClick={saveAll}>표시된 구간 전부 저장</button>
            {/* <button onClick={nextFile}>작업완료&목록에서 제외</button> */}
            {/* <button className="font-weight-bold" onClick={completeAndNext}>현재 파일 작업완료 or 목록에서 제외</button> */}
          </div>
        )}
      </div>

      {/* Right: loaded list */}
      {/* <div className="col-span-3 gray-background" >
              <div className="text-sm font-semibold">불러온 목록 {files.length}개</div>
              <div className="text-xs text-slate-500"></div>
        <div className="sticky  max-h-[90vh] overflow-auto shadow">
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
            </div> */}

                  {/* Right: loaded list */}
     {/* <div className="col-span-3 gray-background"> */}
        {/* <div className="sticky top-6 max-h-[90vh] overflow-auto shadow rounded-lg bg-white"> */}
          {/* 헤더 */}
          {/* <div className="px-3 pt-3 pb-2 border-b flex items-baseline gap-2">
            <h2 className="text-lg font-semibold leading-none">불러온 목록</h2>
            <span className="text-[11px] text-slate-500">({files.length}개)</span>
          </div> */}

          {/* <div className="px-3 pt-3 pb-2 border-b flex items-center justify-between">
  <div className="flex items-baseline gap-2">
    <h2 className="text-lg font-semibold leading-none">불러온 목록</h2>
    <span className="text-[11px] text-slate-500">({files.length}개)</span>
  </div>
  <div className="flex gap-2">
    <button onClick={() => fileInputRef.current?.click()}>파일 불러오기</button>
    <button onClick={() => folderInputRef.current?.click()}>폴더 불러오기</button>
  </div>
</div>
          <div className="p-3 space-y-2">
            <div className="divide-y">
              
              {files.map((f, i) => (
                <div
                  key={i}
                  className={`p-2 cursor-pointer hover:bg-slate-400 rounded ${
                    i === current ? "bg-slate-400 text-white" : ""
                  }`}
                  // onClick={() => setCurrent(i)}
                  onClick={() => {
                    // 현재 파일 진행상황 저장
                    persistCurrent();
                    isRestoringRef.current = true;
                    setCurrent(i);
                    requestAnimationFrame(() => {     // 4) 한 틱 뒤 저장 재개
                      isRestoringRef.current = false;
                       });
                  }}
                >
                  <div className="text-sm truncate">{f.name}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div> */}
      {/* Right: loaded list */}
<div className="col-span-3 gray-background relative">
  <div className="max-h-[90vh] overflow-auto shadow rounded-lg bg-white ">
    {/* 헤더 + 목록 */}
    <div className="px-3 pt-3 pb-2 border-b flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold leading-none">불러온 목록</h2>
        <span className="text-[11px] text-slate-500">({files.length}개)</span>
      </div>
      <div className="flex gap-2">
        <button onClick={() => fileInputRef.current?.click()}>파일 불러오기</button>
        <button onClick={() => folderInputRef.current?.click()}>폴더 불러오기</button>
      </div>
    </div>

    <div className="p-3 space-y-2">
      <div className="divide-y">
        {files.map((f, i) => (
          <div
            key={i}
            className={`p-2 cursor-pointer hover:bg-neutral-300 rounded ${
              i === current ? "bg-indigo-200 text-blue" : ""
            }`}
            onClick={() => {
              persistCurrent();
              isRestoringRef.current = true;
              setCurrent(i);
              requestAnimationFrame(() => { isRestoringRef.current = false; });
            }}
          >
            <div className="text-sm truncate">{f.name}</div>
          </div>
        ))}
      </div>
    </div>
  </div>

  {/* 고정 버튼 */}
  {rows.length > 0 && (
    <div className="absolute bottom-0 left-0 w-full p-2 bg-white border-t shadow">
      <button
        className="font-weight-bold w-full"
        onClick={completeAndNext}
      >
        현재 파일 작업완료 or 목록에서 제외
      </button>
    </div>
  )}
</div>

    </div>
  );
}
