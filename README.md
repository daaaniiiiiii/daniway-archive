# DANI WAY ARCHIVE · v3.0

다니웨이 아카이브 — 글감·영수증·무드·아이디어를 모으는 개인 기록 웹앱.
기록은 아이폰(브라우저 저장소)에 먼저 저장되고, **노션 `DANI WAY ARCHIVE DB`** 에도 함께 쌓입니다.
노션 토큰은 브라우저로 내려가지 않고 Vercel 서버 환경변수에만 있습니다.

```
index.html          웹앱 (단일 파일, 에디토리얼 아카이브 디자인)
apple-touch-icon.png 홈 화면 아이콘
api/health.js       GET   설정 확인 + DANI WAY ARCHIVE DB 자동 생성/조회
api/upload.js       POST  사진 1장 → 노션 파일 업로드(file_upload_id)
api/notes.js        GET   최신순 기록 목록(+본문·이미지 블록)
                    POST  새 기록을 DB 행 + 본문/북마크/이미지 블록으로 저장
                    DELETE ?id=  페이지 보관(archived)
api/link-preview.js GET ?url=  서버에서 OG 태그 파싱
vercel.json         함수 실행시간·CORS 헤더
```

## 배포 (Vercel)

1. https://vercel.com/new 에서 GitHub `daaaniiiiiii/daniway-archive` 저장소를 Import
2. Framework Preset: **Other** (빌드 명령·출력 경로 없음, 정적 파일 그대로 배포)
3. Environment Variables
   - `NOTION_TOKEN` — 노션 API 통합 `DANI WAY` 의 시크릿
   - `NOTION_PAGE_ID` — `1ba770d2-ab63-4c15-ae7e-9b85cb87a76d` (🗒️ DANI WAY ARCHIVE)
4. Deploy → 나온 `https://<프로젝트>.vercel.app` 주소로 접속하면 설정 없이 자동 연결

> GitHub Pages 주소(`daaaniiiiiii.github.io/daniway-archive/`)로 계속 쓰려면,
> 앱 오른쪽 위 `⋯` → Notion 카드의 주소 칸에 Vercel 주소를 넣고 **연결**을 누르면 됩니다.

## API

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 토큰·페이지 확인, `DANI WAY ARCHIVE DB` 없으면 생성 후 `databaseId` 반환 |
| POST | `/api/upload` | `{filename, contentType, data(base64)}` → `{file_upload_id}` (4.5MB 한도 준수) |
| GET | `/api/notes?limit=30` | 최신순 기록 목록 (문단·이미지 `file.url`·북마크 포함) |
| POST | `/api/notes` | `{title, body, tags, link, images[file_upload_id], imageUrls[], createdAt}` |
| DELETE | `/api/notes?id=<page_id>` | 페이지 `archived: true` |
| GET | `/api/link-preview?url=` | `og:title` / `og:description` / `og:image` |

모든 `/api/*` 응답에 CORS(`Access-Control-Allow-Origin: *`, `GET,POST,DELETE,OPTIONS`)가 붙습니다.
외부 npm 패키지 없이 Node 20 기본 `fetch` / `FormData` / `Blob` 만 사용합니다.

## 데이터 구조 (노션 DB)

| 속성 | 타입 | 내용 |
| --- | --- | --- |
| Title | title | 제목(없으면 본문 첫 줄) |
| 태그 | multi_select | 최대 8개 |
| 작성일 | date | 앱에서 남긴 시각 |
| 링크 | url | 본문 첫 링크 |
| 사진수 | number | 페이지에 붙은 사진 수 |

본문은 문단 블록, 링크는 북마크 블록, 사진은 `file_upload` 이미지 블록으로 저장됩니다.

## 확인

```bash
npm run check     # api/*.js 문법 검사
```
