PNG 메타데이터 · 스텔스 제거기

실행:
1. index.html, style.css, app.js를 같은 폴더에 둡니다.
2. index.html을 브라우저에서 엽니다.
3. PNG 파일 또는 폴더를 추가합니다.

처리:
- PNG 텍스트/EXIF 계열 부가 청크 검사
- IEND 뒤 추가 데이터 검사
- NovelAI stealth_pngcomp / stealth_pnginfo 알파 LSB 검사
- 새 캔버스 재인코딩 및 알파값 255 고정
- 변환 결과 재검사

주의:
- 강력 제거 방식이므로 PNG 투명도는 사라집니다.
- ZIP은 무압축(Store) 방식으로 생성되어 용량이 클 수 있습니다.
- 모든 처리는 브라우저 로컬에서 수행됩니다.
