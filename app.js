(() => {
  "use strict";

  const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const STEALTH_MAGICS = ["stealth_pngcomp", "stealth_pnginfo"];
  const state = { items: [], selectedId: "", view: "original", busy: false };
  let idCounter = 0;

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    dropZone: $("#dropZone"), fileInput: $("#fileInput"), folderInput: $("#folderInput"), pasteButton: $("#pasteButton"), clearButton: $("#clearButton"),
    uploadStatus: $("#uploadStatus"), uploadProgress: $("#uploadProgress"), downloadStatus: $("#downloadStatus"), downloadProgress: $("#downloadProgress"),
    downloadSelectedButton: $("#downloadSelectedButton"), downloadZipButton: $("#downloadZipButton"), readyCount: $("#readyCount"), summaryText: $("#summaryText"),
    fileList: $("#fileList"), fileCount: $("#fileCount"), selectedName: $("#selectedName"), selectedState: $("#selectedState"),
    originalTab: $("#originalTab"), convertedTab: $("#convertedTab"), previewImage: $("#previewImage"), previewEmpty: $("#previewEmpty"), imageFacts: $("#imageFacts"),
    metadataBadge: $("#metadataBadge"), metadataOutput: $("#metadataOutput")
  };

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "-";
    const units = ["B", "KB", "MB", "GB"]; let n = bytes; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
  }
  function safeName(name) { return String(name || "image.png").replace(/[\\/:*?"<>|]+/g, "_"); }
  function outputName(name) { return safeName(name).replace(/\.png$/i, "") + "-clean.png"; }
  function createObjectUrl(blob) { return URL.createObjectURL(blob); }
  function revokeItemUrls(item) { [item.originalUrl, item.convertedUrl].filter(Boolean).forEach(URL.revokeObjectURL); }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function isPngFile(file) { return file && (/\.png$/i.test(file.name || "") || file.type === "image/png"); }
  async function validatePng(file) {
    const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (bytes.length !== 8 || !PNG_SIGNATURE.every((v, i) => bytes[i] === v)) throw new Error("PNG 서명이 올바르지 않습니다.");
  }

  function readUint32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false); }
  function decodeLatin1(bytes) { return Array.from(bytes, b => String.fromCharCode(b)).join(""); }
  function decodeUtf8(bytes) { try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { return decodeLatin1(bytes); } }
  function indexOfZero(bytes, start = 0) { for (let i = start; i < bytes.length; i += 1) if (bytes[i] === 0) return i; return -1; }
  async function decompress(bytes, format) {
    if (!("DecompressionStream" in window)) throw new Error("이 브라우저는 압축 메타데이터 해제를 지원하지 않습니다.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function parsePng(file) {
    await validatePng(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks = []; const textEntries = []; let offset = 8; let iendEnd = -1; let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
    while (offset + 12 <= bytes.length) {
      const length = readUint32(bytes, offset); const type = decodeLatin1(bytes.slice(offset + 4, offset + 8)); const dataStart = offset + 8; const dataEnd = dataStart + length; const chunkEnd = dataEnd + 4;
      if (chunkEnd > bytes.length) throw new Error("PNG 청크 길이가 파일 범위를 벗어났습니다.");
      const data = bytes.slice(dataStart, dataEnd); chunks.push({ type, length });
      if (type === "IHDR" && length >= 13) { width = readUint32(data, 0); height = readUint32(data, 4); bitDepth = data[8]; colorType = data[9]; }
      if (type === "tEXt") {
        const zero = indexOfZero(data); if (zero >= 0) textEntries.push({ chunk: type, key: decodeLatin1(data.slice(0, zero)), value: decodeLatin1(data.slice(zero + 1)) });
      } else if (type === "zTXt") {
        const zero = indexOfZero(data); if (zero >= 0 && data[zero + 1] === 0) {
          try { const decoded = await decompress(data.slice(zero + 2), "deflate"); textEntries.push({ chunk: type, key: decodeLatin1(data.slice(0, zero)), value: decodeLatin1(decoded) }); }
          catch (error) { textEntries.push({ chunk: type, key: decodeLatin1(data.slice(0, zero)), value: `[압축 해제 실패: ${error.message}]` }); }
        }
      } else if (type === "iTXt") {
        const keyEnd = indexOfZero(data); if (keyEnd >= 0) {
          const compressed = data[keyEnd + 1] === 1; let cursor = keyEnd + 3; const languageEnd = indexOfZero(data, cursor); cursor = languageEnd + 1; const translatedEnd = indexOfZero(data, cursor); cursor = translatedEnd + 1;
          try { const payload = compressed ? await decompress(data.slice(cursor), "deflate") : data.slice(cursor); textEntries.push({ chunk: type, key: decodeLatin1(data.slice(0, keyEnd)), value: decodeUtf8(payload) }); }
          catch (error) { textEntries.push({ chunk: type, key: decodeLatin1(data.slice(0, keyEnd)), value: `[압축 해제 실패: ${error.message}]` }); }
        }
      } else if (type === "IEND") { iendEnd = chunkEnd; break; }
      offset = chunkEnd;
    }
    const trailingBytes = iendEnd >= 0 ? bytes.length - iendEnd : bytes.length;
    return { bytes, chunks, textEntries, trailingBytes, width, height, bitDepth, colorType };
  }

  async function imageDataFromBlob(blob) {
    const bitmap = await createImageBitmap(blob); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0); bitmap.close();
    return { canvas, context, imageData: context.getImageData(0, 0, canvas.width, canvas.height), width: canvas.width, height: canvas.height };
  }
  function alphaTransposed(imageData, width, height) {
    const out = new Uint8Array(width * height); let cursor = 0;
    for (let x = 0; x < width; x += 1) for (let y = 0; y < height; y += 1) out[cursor++] = imageData.data[(y * width + x) * 4 + 3];
    return out;
  }
  function alphaRowMajor(imageData) {
    const out = new Uint8Array(imageData.data.length / 4); for (let i = 0; i < out.length; i += 1) out[i] = imageData.data[i * 4 + 3]; return out;
  }
  function lsbBytes(alpha) {
    const count = Math.floor(alpha.length / 8); const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) { let value = 0; for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (alpha[i * 8 + bit] & 1); out[i] = value; }
    return out;
  }
  async function decodeStealthStream(streamBytes, traversal) {
    for (const magic of STEALTH_MAGICS) {
      const magicBytes = new TextEncoder().encode(magic); if (streamBytes.length < magicBytes.length + 4) continue;
      let match = true; for (let i = 0; i < magicBytes.length; i += 1) if (streamBytes[i] !== magicBytes[i]) { match = false; break; }
      if (!match) continue;
      const bitLength = readUint32(streamBytes, magicBytes.length); const byteLength = Math.ceil(bitLength / 8); const payload = streamBytes.slice(magicBytes.length + 4, magicBytes.length + 4 + byteLength);
      let decoded = payload;
      if (magic === "stealth_pngcomp") decoded = await decompress(payload, "gzip");
      const text = decodeUtf8(decoded); let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { found: true, magic, traversal, bitLength, data: parsed, text };
    }
    return null;
  }
  async function inspectStealth(imageData, width, height) {
    const candidates = [
      { traversal: "NovelAI transpose", alpha: alphaTransposed(imageData, width, height) },
      { traversal: "row-major", alpha: alphaRowMajor(imageData) }
    ];
    for (const candidate of candidates) {
      try { const result = await decodeStealthStream(lsbBytes(candidate.alpha), candidate.traversal); if (result) return result; } catch (error) { return { found: true, magic: "스텔스 서명 감지", traversal: candidate.traversal, error: error.message, data: null, text: "" }; }
    }
    return { found: false };
  }

  async function inspectBlob(blob) {
    const png = await parsePng(blob); const pixels = await imageDataFromBlob(blob); const stealth = await inspectStealth(pixels.imageData, pixels.width, pixels.height);
    let alphaMin = 255; let alphaMax = 0; const alphaValues = new Set();
    for (let i = 3; i < pixels.imageData.data.length; i += 4) { const a = pixels.imageData.data[i]; alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a); if (alphaValues.size < 300) alphaValues.add(a); }
    const ancillary = png.chunks.filter(({ type }) => !["IHDR", "PLTE", "IDAT", "IEND", "tRNS"].includes(type));
    const hasMetadata = png.textEntries.length > 0 || png.trailingBytes > 0 || stealth.found || ancillary.some(({ type }) => ["eXIf", "iCCP", "tIME"].includes(type));
    return { ...png, stealth, width: pixels.width, height: pixels.height, alphaMin, alphaMax, alphaUniqueCount: alphaValues.size, ancillary, hasMetadata };
  }

  async function sanitizeBlob(blob) {
    const { canvas, context, imageData } = await imageDataFromBlob(blob);
    for (let i = 3; i < imageData.data.length; i += 4) imageData.data[i] = 255;
    context.putImageData(imageData, 0, 0);
    const cleaned = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG 변환에 실패했습니다.")), "image/png"));
    const report = await inspectBlob(cleaned);
    if (report.stealth.found || report.textEntries.length || report.trailingBytes || report.alphaMin !== 255 || report.alphaMax !== 255) throw new Error("변환 후 검증에서 숨김정보가 남았습니다.");
    return { blob: cleaned, report };
  }

  async function collectDroppedFiles(dataTransfer) {
    const items = [...(dataTransfer.items || [])]; const output = [];
    async function walkEntry(entry, path = "") {
      if (entry.isFile) await new Promise(resolve => entry.file(file => { file.relativePath = path + file.name; output.push(file); resolve(); }, resolve));
      else if (entry.isDirectory) {
        const reader = entry.createReader(); let batch;
        do { batch = await new Promise(resolve => reader.readEntries(resolve)); for (const child of batch) await walkEntry(child, `${path}${entry.name}/`); } while (batch.length);
      }
    }
    const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const entry of entries) await walkEntry(entry);
    else output.push(...[...(dataTransfer.files || [])]);
    return output;
  }

  async function addFiles(files) {
    const pngs = [...files].filter(isPngFile); if (!pngs.length) { elements.uploadStatus.textContent = "PNG 파일이 없습니다."; return; }
    state.busy = true; updateControls(); elements.uploadProgress.value = 0; elements.uploadStatus.textContent = `${pngs.length}개 처리 준비`;
    for (let index = 0; index < pngs.length; index += 1) {
      const file = pngs[index]; const relativePath = file.webkitRelativePath || file.relativePath || file.name; const id = `png-${Date.now()}-${++idCounter}`;
      const item = { id, name: file.name || `clipboard-${idCounter}.png`, relativePath, original: file, originalUrl: createObjectUrl(file), converted: null, convertedUrl: "", originalReport: null, convertedReport: null, error: "", status: "processing" };
      state.items.push(item); if (!state.selectedId) state.selectedId = id; render();
      try {
        elements.uploadStatus.textContent = `${index + 1}/${pngs.length} ${item.name} 검사·변환 중`;
        item.originalReport = await inspectBlob(file);
        const converted = await sanitizeBlob(file); item.converted = converted.blob; item.convertedReport = converted.report; item.convertedUrl = createObjectUrl(converted.blob); item.status = "ready";
      } catch (error) { item.error = error.message || "처리 실패"; item.status = "error"; }
      elements.uploadProgress.value = Math.round(((index + 1) / pngs.length) * 100); render(); await new Promise(requestAnimationFrame);
    }
    state.busy = false; elements.uploadStatus.textContent = `${pngs.length}개 처리 완료`; updateControls(); render();
  }

  function selectedItem() { return state.items.find(item => item.id === state.selectedId) || null; }
  function currentData(item) { return state.view === "converted" ? { blob: item.converted, url: item.convertedUrl, report: item.convertedReport } : { blob: item.original, url: item.originalUrl, report: item.originalReport }; }
  function reportLabel(report) { return report?.hasMetadata ? "정보 감지" : "감지 없음"; }
  function renderList() {
    elements.fileCount.textContent = `${state.items.length}개`;
    if (!state.items.length) { elements.fileList.innerHTML = '<div class="empty-state">아직 추가된 PNG가 없습니다.</div>'; return; }
    elements.fileList.innerHTML = state.items.map(item => {
      const report = item.originalReport; const statusClass = item.status === "error" || report?.hasMetadata ? "found" : "clean";
      const statusText = item.status === "processing" ? "처리 중" : item.status === "error" ? "오류" : report?.hasMetadata ? "정보 감지" : "원본 깨끗함";
      return `<button class="file-item ${item.id === state.selectedId ? "is-selected" : ""}" type="button" data-select-id="${escapeHtml(item.id)}" role="option" aria-selected="${item.id === state.selectedId}">
        <span class="file-thumb"><img src="${escapeHtml(item.originalUrl)}" alt=""></span>
        <span class="file-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.relativePath)} · ${formatBytes(item.original.size)}</span></span>
        <span class="file-status"><em class="${statusClass}">${statusText}</em>${item.converted ? `<span class="item-download" data-download-id="${escapeHtml(item.id)}">다운로드</span>` : ""}</span>
      </button>`;
    }).join("");
  }
  function metadataRows(entries) {
    return `<table class="meta-table"><tbody>${entries.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody></table>`;
  }
  function prettyData(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  function renderMetadata(report) {
    if (!report) { elements.metadataBadge.className = "result-badge is-neutral"; elements.metadataBadge.textContent = "대기"; elements.metadataOutput.innerHTML = '<p class="empty-state">검사 결과를 기다리는 중입니다.</p>'; return; }
    const found = report.hasMetadata; elements.metadataBadge.className = `result-badge ${found ? "is-found" : "is-clean"}`; elements.metadataBadge.textContent = found ? "정보 감지" : "감지 없음";
    const sections = [];
    sections.push(`<section class="meta-section"><h3>PNG 구조</h3>${metadataRows([
      ["청크", report.chunks.map(c => `${c.type}(${c.length})`).join(", ")], ["부가 청크", report.ancillary.length ? report.ancillary.map(c => c.type).join(", ") : "없음"], ["IEND 뒤 데이터", `${report.trailingBytes} bytes`]
    ])}</section>`);
    sections.push(`<section class="meta-section"><h3>알파 채널</h3>${metadataRows([["최솟값", report.alphaMin], ["최댓값", report.alphaMax], ["고유값 수", report.alphaUniqueCount], ["완전 불투명", report.alphaMin === 255 && report.alphaMax === 255 ? "예" : "아니오"]])}</section>`);
    if (report.textEntries.length) sections.push(`<section class="meta-section"><h3>PNG 텍스트 메타데이터</h3>${report.textEntries.map(entry => `<p><strong>${escapeHtml(entry.chunk)} · ${escapeHtml(entry.key)}</strong></p><pre class="meta-code">${escapeHtml(entry.value)}</pre>`).join("")}</section>`);
    else sections.push('<section class="meta-section"><h3>PNG 텍스트 메타데이터</h3><p class="empty-state">없음</p></section>');
    if (report.stealth.found) {
      sections.push(`<section class="meta-section"><h3>알파 채널 스텔스 정보</h3>${metadataRows([["형식", report.stealth.magic], ["픽셀 순회", report.stealth.traversal], ["데이터 길이", report.stealth.bitLength ? `${report.stealth.bitLength} bits` : "확인 불가"]])}<pre class="meta-code">${escapeHtml(report.stealth.error || prettyData(report.stealth.data))}</pre></section>`);
    } else sections.push('<section class="meta-section"><h3>알파 채널 스텔스 정보</h3><p class="empty-state">NovelAI stealth_pngcomp / stealth_pnginfo 서명이 감지되지 않았습니다.</p></section>');
    elements.metadataOutput.innerHTML = sections.join("");
  }
  function renderInspector() {
    const item = selectedItem(); const hasItem = Boolean(item); elements.originalTab.disabled = !hasItem; elements.convertedTab.disabled = !item?.converted;
    elements.originalTab.classList.toggle("is-active", state.view === "original"); elements.convertedTab.classList.toggle("is-active", state.view === "converted");
    if (!item) {
      elements.selectedName.textContent = "선택된 이미지 없음"; elements.selectedState.textContent = "목록에서 이미지를 선택하세요."; elements.previewImage.hidden = true; elements.previewEmpty.hidden = false; elements.imageFacts.innerHTML = ""; renderMetadata(null); return;
    }
    if (state.view === "converted" && !item.converted) state.view = "original";
    const data = currentData(item); elements.selectedName.textContent = item.name; elements.selectedState.textContent = state.view === "original" ? "변환 전 원본 검사" : "정제 완료 이미지 재검사";
    elements.previewImage.src = data.url; elements.previewImage.hidden = false; elements.previewEmpty.hidden = true;
    const report = data.report; elements.imageFacts.innerHTML = report ? [["크기", `${report.width} × ${report.height}`], ["파일 용량", formatBytes(data.blob.size)], ["비트 깊이", report.bitDepth], ["컬러 타입", report.colorType]].map(([k,v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("") : "";
    renderMetadata(report);
  }
  function updateControls() {
    const ready = state.items.filter(item => item.converted); const selected = selectedItem();
    elements.readyCount.textContent = `${ready.length}개 준비`; elements.downloadZipButton.disabled = state.busy || !ready.length; elements.downloadSelectedButton.disabled = state.busy || !selected?.converted; elements.clearButton.disabled = state.busy || !state.items.length;
    elements.summaryText.textContent = state.items.length ? `총 ${state.items.length}개 · 변환 완료 ${ready.length}개 · 오류 ${state.items.filter(i => i.error).length}개` : "PNG를 추가하면 원본 검사 결과와 변환 결과가 표시됩니다.";
  }
  function render() { renderList(); renderInspector(); updateControls(); }

  function crc32(bytes) {
    let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0;
  }
  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear()); const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2); const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(); return { time, day };
  }
  async function createStoredZip(files, onProgress) {
    const encoder = new TextEncoder(); const locals = []; const centrals = []; let offset = 0; const stamp = dosDateTime();
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]; const nameBytes = encoder.encode(file.name.replace(/^\/+/, "")); const data = new Uint8Array(await file.blob.arrayBuffer()); const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length); const lv = new DataView(local.buffer); lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true); lv.setUint16(10, stamp.time, true); lv.setUint16(12, stamp.day, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true); local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length); locals.push(local);
      const central = new Uint8Array(46 + nameBytes.length); const cv = new DataView(central.buffer); cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, stamp.time, true); cv.setUint16(14, stamp.day, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true); central.set(nameBytes, 46); centrals.push(central); offset += local.length; onProgress?.(Math.round(((i + 1) / files.length) * 90));
    }
    const centralSize = centrals.reduce((sum, b) => sum + b.length, 0); const end = new Uint8Array(22); const ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true); onProgress?.(100);
    return new Blob([...locals, ...centrals, end], { type: "application/zip" });
  }

  async function downloadAll() {
    const ready = state.items.filter(i => i.converted); if (!ready.length) return; elements.downloadZipButton.disabled = true; elements.downloadProgress.value = 0; elements.downloadStatus.textContent = "ZIP 생성 중";
    try {
      const files = ready.map(item => { const relative = item.relativePath || item.name; const parts = relative.split(/[\\/]/); parts[parts.length - 1] = outputName(parts.pop() || item.name); return { name: parts.join("/"), blob: item.converted }; });
      const zip = await createStoredZip(files, value => { elements.downloadProgress.value = value; elements.downloadStatus.textContent = `ZIP 생성 ${value}%`; }); downloadBlob(zip, `png-cleaned-${new Date().toISOString().slice(0,10)}.zip`); elements.downloadStatus.textContent = `${ready.length}개 ZIP 다운로드 완료`;
    } catch (error) { elements.downloadStatus.textContent = `ZIP 실패: ${error.message}`; } finally { updateControls(); }
  }

  elements.fileInput.addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
  elements.folderInput.addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
  ["dragenter", "dragover"].forEach(type => elements.dropZone.addEventListener(type, e => { e.preventDefault(); elements.dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach(type => elements.dropZone.addEventListener(type, e => { e.preventDefault(); elements.dropZone.classList.remove("is-dragging"); }));
  elements.dropZone.addEventListener("drop", async e => addFiles(await collectDroppedFiles(e.dataTransfer)));
  elements.dropZone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") elements.fileInput.click(); });
  document.addEventListener("paste", e => { const files = [...(e.clipboardData?.files || [])].filter(isPngFile); if (files.length) { e.preventDefault(); addFiles(files); } });
  elements.pasteButton.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error("클립보드 파일 읽기를 지원하지 않는 브라우저입니다. Ctrl+V를 사용하세요.");
      const clipboard = await navigator.clipboard.read(); const files = [];
      for (const item of clipboard) for (const type of item.types) if (type === "image/png") { const blob = await item.getType(type); files.push(new File([blob], `clipboard-${Date.now()}.png`, { type })); }
      await addFiles(files);
    } catch (error) { elements.uploadStatus.textContent = error.message; }
  });
  elements.fileList.addEventListener("click", e => {
    const downloadTarget = e.target.closest("[data-download-id]"); if (downloadTarget) { e.stopPropagation(); const item = state.items.find(i => i.id === downloadTarget.dataset.downloadId); if (item?.converted) downloadBlob(item.converted, outputName(item.name)); return; }
    const target = e.target.closest("[data-select-id]"); if (target) { state.selectedId = target.dataset.selectId; render(); }
  });
  elements.originalTab.addEventListener("click", () => { state.view = "original"; render(); });
  elements.convertedTab.addEventListener("click", () => { state.view = "converted"; render(); });
  elements.downloadSelectedButton.addEventListener("click", () => { const item = selectedItem(); if (item?.converted) downloadBlob(item.converted, outputName(item.name)); });
  elements.downloadZipButton.addEventListener("click", downloadAll);
  elements.clearButton.addEventListener("click", () => { state.items.forEach(revokeItemUrls); state.items = []; state.selectedId = ""; state.view = "original"; elements.uploadProgress.value = 0; elements.downloadProgress.value = 0; elements.uploadStatus.textContent = "대기 중"; elements.downloadStatus.textContent = "대기 중"; render(); });
  render();
})();
