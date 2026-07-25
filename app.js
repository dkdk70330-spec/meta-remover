(() => {
  "use strict";

  const PNG_SIGNATURE = new Uint8Array([137,80,78,71,13,10,26,10]);
  const STEALTH_MAGICS = ["stealth_pngcomp", "stealth_pnginfo"];
  const state = { uploads: [], ready: [], selectedReadyId: "", busy: false, inspect: null };
  let idCounter = 0;
  const $ = (selector) => document.querySelector(selector);
  const el = {
    dropZone: $("#dropZone"), fileInput: $("#fileInput"), folderInput: $("#folderInput"), selectFilesButton: $("#selectFilesButton"), selectFolderButton: $("#selectFolderButton"), pasteUploadButton: $("#pasteUploadButton"), clearUploadButton: $("#clearUploadButton"),
    uploadList: $("#uploadList"), removeMetadataButton: $("#removeMetadataButton"), uploadStatus: $("#uploadStatus"), uploadProgress: $("#uploadProgress"),
    downloadList: $("#downloadList"), readyCount: $("#readyCount"), downloadSelectedButton: $("#downloadSelectedButton"), downloadZipButton: $("#downloadZipButton"), downloadStatus: $("#downloadStatus"), downloadProgress: $("#downloadProgress"),
    inspectDropZone: $("#inspectDropZone"), inspectFileInput: $("#inspectFileInput"), inspectPasteButton: $("#inspectPasteButton"), inspectResultTitle: $("#inspectResultTitle"), inspectImage: $("#inspectImage"), inspectImageEmpty: $("#inspectImageEmpty")
  };

  function escapeHtml(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
  function formatBytes(bytes){if(!Number.isFinite(bytes))return"-";const u=["B","KB","MB","GB"];let n=bytes,i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return`${n.toFixed(i?2:0)} ${u[i]}`;}
  function safeName(name){return String(name||"image.png").replace(/[\\/:*?"<>|]+/g,"_");}
  function outputName(name){return safeName(name).replace(/\.png$/i,"")+"-clean.png";}
  function isPngFile(file){return file&&(/\.png$/i.test(file.name||"")||file.type==="image/png");}
  function createUrl(blob){return URL.createObjectURL(blob);}
  function revoke(url){if(url)URL.revokeObjectURL(url);}
  function downloadBlob(blob,name){const url=createUrl(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>revoke(url),1200);}

  async function validatePng(file){const bytes=new Uint8Array(await file.slice(0,8).arrayBuffer());if(bytes.length!==8||!PNG_SIGNATURE.every((v,i)=>bytes[i]===v))throw new Error("PNG 서명이 올바르지 않습니다.");}
  function readUint32(bytes,offset){return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,false);}
  function decodeLatin1(bytes){return Array.from(bytes,b=>String.fromCharCode(b)).join("");}
  function decodeUtf8(bytes){try{return new TextDecoder("utf-8",{fatal:false}).decode(bytes);}catch{return decodeLatin1(bytes);}}
  function indexOfZero(bytes,start=0){for(let i=start;i<bytes.length;i++)if(bytes[i]===0)return i;return-1;}
  async function decompress(bytes,format){if(!("DecompressionStream" in window))throw new Error("압축 메타데이터 해제를 지원하지 않는 브라우저입니다.");const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));return new Uint8Array(await new Response(stream).arrayBuffer());}

  async function parsePng(file){
    await validatePng(file);const bytes=new Uint8Array(await file.arrayBuffer());const chunks=[],textEntries=[];let offset=8,iendEnd=-1,width=0,height=0,bitDepth=0,colorType=0;
    while(offset+12<=bytes.length){
      const length=readUint32(bytes,offset),type=decodeLatin1(bytes.slice(offset+4,offset+8)),dataStart=offset+8,dataEnd=dataStart+length,chunkEnd=dataEnd+4;
      if(chunkEnd>bytes.length)throw new Error("PNG 청크 길이가 파일 범위를 벗어났습니다.");const data=bytes.slice(dataStart,dataEnd);chunks.push({type,length});
      if(type==="IHDR"&&length>=13){width=readUint32(data,0);height=readUint32(data,4);bitDepth=data[8];colorType=data[9];}
      if(type==="tEXt"){const z=indexOfZero(data);if(z>=0)textEntries.push({chunk:type,key:decodeLatin1(data.slice(0,z)),value:decodeLatin1(data.slice(z+1))});}
      else if(type==="zTXt"){const z=indexOfZero(data);if(z>=0&&data[z+1]===0){try{const decoded=await decompress(data.slice(z+2),"deflate");textEntries.push({chunk:type,key:decodeLatin1(data.slice(0,z)),value:decodeLatin1(decoded)});}catch(error){textEntries.push({chunk:type,key:decodeLatin1(data.slice(0,z)),value:`[압축 해제 실패: ${error.message}]`});}}}
      else if(type==="iTXt"){const keyEnd=indexOfZero(data);if(keyEnd>=0){const compressed=data[keyEnd+1]===1;let cursor=keyEnd+3;const languageEnd=indexOfZero(data,cursor);cursor=languageEnd+1;const translatedEnd=indexOfZero(data,cursor);cursor=translatedEnd+1;try{const payload=compressed?await decompress(data.slice(cursor),"deflate"):data.slice(cursor);textEntries.push({chunk:type,key:decodeLatin1(data.slice(0,keyEnd)),value:decodeUtf8(payload)});}catch(error){textEntries.push({chunk:type,key:decodeLatin1(data.slice(0,keyEnd)),value:`[압축 해제 실패: ${error.message}]`});}}}
      else if(type==="IEND"){iendEnd=chunkEnd;break;}offset=chunkEnd;
    }
    return{bytes,chunks,textEntries,trailingBytes:iendEnd>=0?bytes.length-iendEnd:bytes.length,width,height,bitDepth,colorType};
  }

  async function imageDataFromBlob(blob){const bitmap=await createImageBitmap(blob),canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext("2d",{willReadFrequently:true});context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0);bitmap.close();return{canvas,context,imageData:context.getImageData(0,0,canvas.width,canvas.height),width:canvas.width,height:canvas.height};}
  function alphaTransposed(imageData,width,height){const out=new Uint8Array(width*height);let c=0;for(let x=0;x<width;x++)for(let y=0;y<height;y++)out[c++]=imageData.data[(y*width+x)*4+3];return out;}
  function alphaRowMajor(imageData){const out=new Uint8Array(imageData.data.length/4);for(let i=0;i<out.length;i++)out[i]=imageData.data[i*4+3];return out;}
  function lsbBytes(alpha){const out=new Uint8Array(Math.floor(alpha.length/8));for(let i=0;i<out.length;i++){let value=0;for(let bit=0;bit<8;bit++)value=(value<<1)|(alpha[i*8+bit]&1);out[i]=value;}return out;}
  async function decodeStealthStream(streamBytes,traversal){for(const magic of STEALTH_MAGICS){const magicBytes=new TextEncoder().encode(magic);if(streamBytes.length<magicBytes.length+4)continue;let match=true;for(let i=0;i<magicBytes.length;i++)if(streamBytes[i]!==magicBytes[i]){match=false;break;}if(!match)continue;const bitLength=readUint32(streamBytes,magicBytes.length),byteLength=Math.ceil(bitLength/8),payload=streamBytes.slice(magicBytes.length+4,magicBytes.length+4+byteLength);let decoded=payload;if(magic==="stealth_pngcomp")decoded=await decompress(payload,"gzip");const text=decodeUtf8(decoded);let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}return{found:true,magic,traversal,bitLength,data:parsed,text};}return null;}
  async function inspectStealth(imageData,width,height){for(const candidate of[{traversal:"NovelAI transpose",alpha:alphaTransposed(imageData,width,height)},{traversal:"row-major",alpha:alphaRowMajor(imageData)}]){try{const result=await decodeStealthStream(lsbBytes(candidate.alpha),candidate.traversal);if(result)return result;}catch(error){return{found:true,magic:"스텔스 서명 감지",traversal:candidate.traversal,error:error.message,data:null,text:""};}}return{found:false};}

  async function inspectBlob(blob){const png=await parsePng(blob),pixels=await imageDataFromBlob(blob),stealth=await inspectStealth(pixels.imageData,pixels.width,pixels.height);let alphaMin=255,alphaMax=0;const alphaValues=new Set();for(let i=3;i<pixels.imageData.data.length;i+=4){const a=pixels.imageData.data[i];alphaMin=Math.min(alphaMin,a);alphaMax=Math.max(alphaMax,a);if(alphaValues.size<300)alphaValues.add(a);}const ancillary=png.chunks.filter(({type})=>!["IHDR","PLTE","IDAT","IEND","tRNS"].includes(type));const hasMetadata=png.textEntries.length>0||png.trailingBytes>0||stealth.found||ancillary.some(({type})=>["eXIf","iCCP","tIME"].includes(type));return{...png,stealth,width:pixels.width,height:pixels.height,alphaMin,alphaMax,alphaUniqueCount:alphaValues.size,ancillary,hasMetadata};}
  async function sanitizeBlob(blob){const{canvas,context,imageData}=await imageDataFromBlob(blob);for(let i=3;i<imageData.data.length;i+=4)imageData.data[i]=255;context.putImageData(imageData,0,0);const cleaned=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("PNG 변환에 실패했습니다.")),"image/png"));const report=await inspectBlob(cleaned);if(report.hasMetadata||report.alphaMin!==255||report.alphaMax!==255)throw new Error("변환 후 검증에서 메타데이터 또는 스텔스 정보가 남았습니다.");return{blob:cleaned,report};}

  async function collectDroppedFiles(dataTransfer){const items=[...(dataTransfer.items||[])],output=[];async function walk(entry,path=""){if(entry.isFile)await new Promise(resolve=>entry.file(file=>{file.relativePath=path+file.name;output.push(file);resolve();},resolve));else if(entry.isDirectory){const reader=entry.createReader();let batch;do{batch=await new Promise(resolve=>reader.readEntries(resolve));for(const child of batch)await walk(child,`${path}${entry.name}/`);}while(batch.length);}}const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length)for(const entry of entries)await walk(entry);else output.push(...[...(dataTransfer.files||[])]);return output;}

  function addUploadFiles(files){const pngs=[...files].filter(isPngFile);if(!pngs.length){el.uploadStatus.textContent="PNG 파일이 없습니다.";return;}for(const file of pngs){const id=`upload-${Date.now()}-${++idCounter}`;state.uploads.push({id,name:file.name||`clipboard-${idCounter}.png`,relativePath:file.webkitRelativePath||file.relativePath||file.name,blob:file,url:createUrl(file),status:"waiting",error:""});}el.uploadStatus.textContent=`${pngs.length}개 추가됨`;render();}
  async function removeMetadata(){if(state.busy||!state.uploads.length)return;state.busy=true;el.uploadProgress.value=0;render();const targets=[...state.uploads];for(let i=0;i<targets.length;i++){const item=targets[i];item.status="processing";el.uploadStatus.textContent=`${i+1}/${targets.length} ${item.name} 제거·검증 중`;render();try{const originalReport=await inspectBlob(item.blob);const cleaned=await sanitizeBlob(item.blob);const ready={id:`ready-${Date.now()}-${++idCounter}`,sourceId:item.id,name:item.name,relativePath:item.relativePath,blob:cleaned.blob,url:createUrl(cleaned.blob),report:cleaned.report,originalReport};state.ready.push(ready);state.selectedReadyId=ready.id;item.status="done";}catch(error){item.status="error";item.error=error.message||"처리 실패";}el.uploadProgress.value=Math.round(((i+1)/targets.length)*100);render();await new Promise(requestAnimationFrame);}state.busy=false;el.uploadStatus.textContent=`${targets.length}개 처리 완료`;render();}

  function renderUploads(){if(!state.uploads.length){el.uploadList.innerHTML='<p class="empty-state">아직 업로드된 PNG가 없습니다.</p>';return;}el.uploadList.innerHTML=state.uploads.map(item=>`<div class="upload-thumb-only ${item.status==='processing'?'is-processing':item.status==='error'?'is-error':item.status==='done'?'is-done':''}" title="${escapeHtml(item.name)}"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}"></div>`).join("");}
  function renderDownloads(){el.readyCount.textContent=`${state.ready.length}개 준비`;if(!state.ready.length){el.downloadList.innerHTML='<p class="empty-state">제거가 완료되면 여기에 변환 이미지가 표시됩니다.</p>';return;}el.downloadList.innerHTML=state.ready.map(item=>`<button class="thumb-item ${item.id===state.selectedReadyId?'is-selected':''}" type="button" data-ready-id="${escapeHtml(item.id)}"><img src="${escapeHtml(item.url)}" alt=""><span class="thumb-copy"><strong>${escapeHtml(outputName(item.name))}</strong><span>${formatBytes(item.blob.size)} · 클릭하면 확인 카드에 표시</span></span><span><em class="thumb-state clean">삭제됨</em><span class="item-download" data-download-ready="${escapeHtml(item.id)}">다운로드</span></span></button>`).join("");}

  function metadataRows(entries){return`<table class="meta-table"><tbody>${entries.map(([k,v])=>`<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;}
  function prettyData(value){return typeof value==="string"?value:JSON.stringify(value,null,2);}
  function renderInspect(){const target=state.inspect;if(!target){el.inspectResultTitle.className="inspect-result is-neutral";el.inspectResultTitle.textContent="이미지를 선택하세요";el.inspectImage.hidden=true;el.inspectImage.removeAttribute("src");el.inspectImageEmpty.hidden=false;return;}const found=target.report.hasMetadata;el.inspectResultTitle.className=`inspect-result ${found?'is-found':'is-clean'}`;el.inspectResultTitle.textContent=found?"EXIF 정보 확인됨":"EXIF 삭제됨";el.inspectImage.src=target.url;el.inspectImage.hidden=false;el.inspectImageEmpty.hidden=true;}

  async function setInspectBlob(blob,name){try{await validatePng(blob);const report=await inspectBlob(blob);if(state.inspect?.ownedUrl)revoke(state.inspect.url);state.inspect={blob,name:name||"inspect.png",url:createUrl(blob),ownedUrl:true,report};renderInspect();}catch(error){el.inspectResultTitle.className="inspect-result is-found";el.inspectResultTitle.textContent="검사 실패";el.inspectImage.hidden=true;el.inspectImageEmpty.hidden=false;}}
  function inspectReady(item){if(state.inspect?.ownedUrl)revoke(state.inspect.url);state.inspect={blob:item.blob,name:outputName(item.name),url:item.url,ownedUrl:false,report:item.report};renderInspect();}

  function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^(0xedb88320&-(crc&1));}return(crc^0xffffffff)>>>0;}
  function dosDateTime(date=new Date()){const year=Math.max(1980,date.getFullYear()),time=(date.getHours()<<11)|(date.getMinutes()<<5)|Math.floor(date.getSeconds()/2),day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();return{time,day};}
  async function createStoredZip(files,onProgress){const encoder=new TextEncoder(),locals=[],centrals=[];let offset=0;const stamp=dosDateTime();for(let i=0;i<files.length;i++){const file=files[i],nameBytes=encoder.encode(file.name.replace(/^\/+/,"")),data=new Uint8Array(await file.blob.arrayBuffer()),crc=crc32(data),local=new Uint8Array(30+nameBytes.length+data.length),lv=new DataView(local.buffer);lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x0800,true);lv.setUint16(8,0,true);lv.setUint16(10,stamp.time,true);lv.setUint16(12,stamp.day,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,nameBytes.length,true);local.set(nameBytes,30);local.set(data,30+nameBytes.length);locals.push(local);const central=new Uint8Array(46+nameBytes.length),cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(10,0,true);cv.setUint16(12,stamp.time,true);cv.setUint16(14,stamp.day,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,nameBytes.length,true);cv.setUint32(42,offset,true);central.set(nameBytes,46);centrals.push(central);offset+=local.length;onProgress?.(Math.round(((i+1)/files.length)*90));}const centralSize=centrals.reduce((s,b)=>s+b.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);onProgress?.(100);return new Blob([...locals,...centrals,end],{type:"application/zip"});}
  async function downloadAll(){if(!state.ready.length)return;el.downloadProgress.value=0;el.downloadStatus.textContent="ZIP 생성 중";try{const files=state.ready.map(item=>{const parts=(item.relativePath||item.name).split(/[\\/]/);parts[parts.length-1]=outputName(parts[parts.length-1]);return{name:parts.join("/"),blob:item.blob};});const zip=await createStoredZip(files,value=>{el.downloadProgress.value=value;el.downloadStatus.textContent=`ZIP 생성 ${value}%`;});downloadBlob(zip,`png-cleaned-${new Date().toISOString().slice(0,10)}.zip`);el.downloadStatus.textContent=`${state.ready.length}개 ZIP 다운로드 완료`;}catch(error){el.downloadStatus.textContent=`ZIP 실패: ${error.message}`;}}

  function updateControls(){
    const hasUploads = state.uploads.length > 0;
    const hasReady = state.ready.length > 0;
    const hasSelectedReady = state.ready.some(item => item.id === state.selectedReadyId);

    el.removeMetadataButton.disabled = state.busy || !hasUploads;
    el.clearUploadButton.disabled = state.busy || !hasUploads;
    el.fileInput.disabled = state.busy;
    el.folderInput.disabled = state.busy;
    el.pasteUploadButton.disabled = state.busy;
    el.downloadSelectedButton.disabled = !hasSelectedReady;
    el.downloadZipButton.disabled = !hasReady;
  }

  function render(){
    renderUploads();
    renderDownloads();
    renderInspect();
    updateControls();
  }

  async function readClipboardPngs(){if(!navigator.clipboard?.read)throw new Error("클립보드 읽기를 지원하지 않습니다. Ctrl+V를 사용하세요.");const clipboard=await navigator.clipboard.read(),files=[];for(const item of clipboard)for(const type of item.types)if(type==="image/png"){const blob=await item.getType(type);files.push(new File([blob],`clipboard-${Date.now()}.png`,{type}));}return files;}

  el.dropZone.addEventListener("click",e=>{if(!e.target.closest("button,label,input"))el.fileInput.click();});
  el.fileInput.addEventListener("change",e=>{addUploadFiles(e.target.files);e.target.value="";});
  el.folderInput.addEventListener("change",e=>{addUploadFiles(e.target.files);e.target.value="";});
  ["dragenter","dragover"].forEach(t=>el.dropZone.addEventListener(t,e=>{e.preventDefault();el.dropZone.classList.add("is-dragging");}));
  ["dragleave","drop"].forEach(t=>el.dropZone.addEventListener(t,e=>{e.preventDefault();el.dropZone.classList.remove("is-dragging");}));
  el.dropZone.addEventListener("drop",async e=>addUploadFiles(await collectDroppedFiles(e.dataTransfer)));
  el.dropZone.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" ")el.fileInput.click();});
  el.pasteUploadButton.addEventListener("click",async()=>{try{addUploadFiles(await readClipboardPngs());}catch(error){el.uploadStatus.textContent=error.message;}});
  el.removeMetadataButton.addEventListener("click",removeMetadata);
  el.clearUploadButton.addEventListener("click",()=>{state.uploads.forEach(i=>revoke(i.url));state.uploads=[];el.uploadProgress.value=0;el.uploadStatus.textContent="대기 중";render();});

  el.downloadList.addEventListener("click",e=>{const download=e.target.closest("[data-download-ready]");if(download){e.stopPropagation();const item=state.ready.find(i=>i.id===download.dataset.downloadReady);if(item)downloadBlob(item.blob,outputName(item.name));return;}const target=e.target.closest("[data-ready-id]");if(target){const item=state.ready.find(i=>i.id===target.dataset.readyId);if(item){state.selectedReadyId=item.id;inspectReady(item);renderDownloads();updateControls();}}});
  el.downloadSelectedButton.addEventListener("click",()=>{const item=state.ready.find(i=>i.id===state.selectedReadyId);if(item)downloadBlob(item.blob,outputName(item.name));});
  el.downloadZipButton.addEventListener("click",downloadAll);

  el.inspectFileInput.addEventListener("change",e=>{const file=e.target.files?.[0];if(file)setInspectBlob(file,file.name);e.target.value="";});
  ["dragenter","dragover"].forEach(t=>el.inspectDropZone.addEventListener(t,e=>{e.preventDefault();el.inspectDropZone.classList.add("is-dragging");}));
  ["dragleave","drop"].forEach(t=>el.inspectDropZone.addEventListener(t,e=>{e.preventDefault();el.inspectDropZone.classList.remove("is-dragging");}));
  el.inspectDropZone.addEventListener("drop",e=>{const file=[...(e.dataTransfer.files||[])].find(isPngFile);if(file)setInspectBlob(file,file.name);});
  el.inspectPasteButton.addEventListener("click",async()=>{try{const files=await readClipboardPngs();if(files[0])setInspectBlob(files[0],files[0].name);}catch(error){el.inspectImage.hidden=true;el.inspectImageEmpty.hidden=false;}});
  document.addEventListener("paste",e=>{const file=[...(e.clipboardData?.files||[])].find(isPngFile);if(!file)return;e.preventDefault();if(document.activeElement===el.inspectDropZone||el.inspectDropZone.contains(document.activeElement))setInspectBlob(file,file.name);else addUploadFiles([file]);});

  render();
})();
