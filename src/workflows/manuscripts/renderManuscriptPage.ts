// manifest(Supabase manuscript_manifest_topics, manuscriptManifest.ts) -> 열람용 index.html.
// file://로도, Cloudflare Pages로도 열리는 정적 페이지라 서버·번들러가 없다 -
// scripts/statusDashboard.ts와 같은 관례(문자열 템플릿 -> writeFile)를 따른다.
//
// 2026-09-15 재설계(BLOGSPOT_ONLY_DESIGN.md §4): 채널 단계가 사라져 트리가 날짜 -> 주제 2단이 됐고,
// 레이아웃·디자인을 사용자가 지정한 참조 파일
// (~/Documents/blog-manuscripts/naver-parenting/viewer.html)과 같은 구성으로 맞췄다.
// 포인트 컬러(--pen)만 그 파일의 벽돌색 대신 오렌지다. 참조 파일이 라이트 전용이라 여기도
// 다크 모드 분기를 두지 않는다(color-scheme:light로 고정해 브라우저가 반전시키지 않게 한다).
//
// 원고 본문은 Node에서 미리 parseManuscriptBlocks로 텍스트/이미지 블록으로 나눠 JSON에 담는다.
// 브라우저 쪽 JS가 같은 정규식을 다시 구현하면 화면에 보이는 것과 "복사" 버튼이 복사하는 것이
// 어긋날 위험이 있어, 파싱은 한 곳(parseManuscriptBlocks)에서만 한다.
//
// 이미지는 manifest의 images[](Supabase Storage 공개 URL)를 본문 마커 자리에 끼워 그린다 -
// 본문 자체에는 손대지 않는다(generateManuscriptImages.ts 주석 참고). A/B 비교 모드에서는 같은
// index에 provider만 다른 이미지가 2장 들어오므로 나란히 보여주고 어느 쪽인지 라벨을 붙인다.
//
// 수정(편집) 결과는 브라우저 localStorage에만 남는다(2026-09-05 사용자 결정) - 로컬 원고 파일은
// 항상 원본 그대로다. 정적 파일이라 서버에 다시 쓸 방법이 없다.

import { parseManuscriptBlocks } from "./parseManuscriptBlocks.js";
import type { ManuscriptBlock } from "./parseManuscriptBlocks.js";
import type { ManuscriptImage, ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";

const CATEGORY_LABEL: Record<string, string> = {
  incident: "사건사고",
  entertainment: "연예",
  ott: "OTT",
  parenting: "육아",
  living: "생활정보",
  community: "이슈",
};

type PageTopic = {
  jobId: string;
  keyword: string;
  category: string | null;
  categoryLabel: string;
  date: string;
  title: string;
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  blocks: ManuscriptBlock[];
  images: ManuscriptImage[];
  /** 공백 제외 본문 글자수(참조 파일의 "본문 N자(공백 제외)"와 같은 기준). */
  charCount: number;
  /**
   * 네이버용 배리에이션(2026-09-18). 이미지는 위 images를 그대로 쓰므로 blocks와 마커 순서가 같다.
   * 생성 전이거나 실패했으면 null - 그때는 네이버 복사 버튼을 숨긴다.
   */
  naver: { title: string; tags: string[]; blocks: ManuscriptBlock[] } | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** <script type="application/json"> 안에 JSON을 안전하게 넣는다 - "</script" 시퀀스만 깨뜨린다. */
function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
}

function toPageTopic(entry: ManuscriptTopicEntry): PageTopic {
  const m = entry.manuscript;
  return {
    jobId: entry.jobId,
    keyword: entry.keyword,
    category: entry.category,
    categoryLabel: (entry.category && CATEGORY_LABEL[entry.category]) || entry.category || "미분류",
    date: entry.date,
    title: m.title,
    searchDescription: m.searchDescription,
    slug: m.slug,
    tags: m.tags,
    blocks: parseManuscriptBlocks(m.body, m.imagePrompts),
    images: m.images,
    charCount: m.body.replace(/\s/g, "").length,
    // 네이버 본문도 같은 파서를 태운다 - 뷰어의 복사 로직(이미지 자리를 [[이미지 N]]으로 남김)을
    // 그대로 재사용하려면 블록 모양이 같아야 한다.
    naver: m.naver
      ? { title: m.naver.title, tags: m.naver.tags, blocks: parseManuscriptBlocks(m.naver.body, m.imagePrompts) }
      : null,
  };
}

export function renderManuscriptPage(manifest: ManuscriptManifest, generatedAt: Date = new Date()): string {
  const topics = [...manifest.topics].sort(
    (a, b) => b.date.localeCompare(a.date) || b.readyAt.localeCompare(a.readyAt)
  );
  const pageTopics = topics.map(toPageTopic);

  const generated = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(generatedAt);

  // kstDateString(prepareManuscript.ts)과 같은 포맷(en-CA -> YYYY-MM-DD)으로 오늘 날짜를 계산해,
  // 그 날짜 그룹만 기본으로 펼쳐 둔다. 오늘 준비된 원고가 없으면 가장 최근 날짜를 펼쳐서,
  // 페이지를 열자마자 전부 접혀 비어 보이는 것을 막는다.
  const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(generatedAt);

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>원고 뷰어</title>
<style>
  :root{color-scheme:light;
        --bg:#FAF7F2;--fg:#2B2621;--muted:#8C8178;--line:#E2D9CB;--card:#F3EDE2;
        --pen:#E8590C;--pen-soft:#FDF0E6;--warn:#8A6A22;
        --font:"Pretendard","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.65 var(--font);word-break:keep-all;-webkit-font-smoothing:antialiased}

  /* 모바일 상단바(햄버거) - 참조 파일엔 없지만 사용자가 폰으로도 본다. 데스크톱에선 숨긴다. */
  .topbar{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);
          position:sticky;top:0;background:var(--bg);z-index:20}
  .topbar-title{font-weight:700;font-size:15px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nav-toggle-btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;
                  width:40px;height:40px;min-width:40px;font-size:18px;line-height:1;cursor:pointer}
  .backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:29}
  body.nav-open .backdrop{display:block}

  aside{position:fixed;top:0;left:0;bottom:0;width:85vw;max-width:300px;background:var(--bg);
        border-right:1px solid var(--line);overflow-y:auto;padding:18px 14px;z-index:30;
        transform:translateX(-100%);transition:transform .2s ease}
  body.nav-open aside{transform:translateX(0)}
  aside h1{font-size:15px;margin:0 0 3px;letter-spacing:-.025em}
  aside .meta{color:var(--muted);font-size:12px;margin-bottom:18px;line-height:1.55}
  .empty{color:var(--muted);padding:16px;font-size:13px}

  .navgroup{margin-bottom:6px}
  .navgroup-title{font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.02em;
          padding:8px 10px;cursor:pointer;border-radius:7px;
          display:flex;align-items:center;justify-content:space-between;user-select:none}
  .navgroup-title:hover{background:var(--card)}
  .navgroup-title .arrow{display:inline-block;transition:transform .15s;color:var(--muted);font-size:10px}
  .navgroup.open .navgroup-title .arrow{transform:rotate(90deg)}
  .navgroup-items{display:none;padding-top:2px}
  .navgroup.open .navgroup-items{display:block}
  .navgroup-title .cnt{font-weight:400;opacity:.75;margin-left:4px}
  .navbtn{display:block;width:100%;text-align:left;background:none;border:none;color:var(--fg);
          padding:9px 10px;border-radius:7px;cursor:pointer;font:inherit;font-size:13px;margin-bottom:2px}
  .navbtn:hover{background:var(--card)}
  .navbtn.active{background:var(--pen);color:#fff}

  main{padding:20px 16px 90px}
  .wrap{max-width:780px}
  .placeholder{color:var(--muted);padding:8px}
  .cat-badge{display:inline-block;font-size:11px;font-weight:700;color:var(--pen);
          border:1px solid var(--pen);border-radius:5px;padding:2px 8px;margin-bottom:8px}
  .doc-title{font-size:19px;font-weight:800;letter-spacing:-.025em;margin:0 0 4px;line-height:1.4}
  .doc-sub{color:var(--muted);font-size:12.5px;margin:0 0 18px}
  .doc-sub code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
  .doc-sub .bad{color:var(--warn);font-weight:700}

  .hint{background:#F3EADC;border-left:3px solid var(--pen);padding:12px 15px;font-size:13px;
        line-height:1.75;border-radius:0 5px 5px 0;margin:0 0 20px}
  .hint code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg);
             border:1px solid var(--line);border-radius:4px;padding:1px 5px}

  .thumbrow{display:flex;gap:16px;align-items:flex-start;margin-bottom:18px;flex-wrap:wrap}
  .thumbrow img{width:184px;height:184px;object-fit:cover;border-radius:8px;flex:0 0 auto;
                border:1px solid var(--line);background:var(--card)}
  .thumbrow .tx{font-size:12.5px;color:var(--muted);line-height:1.8;flex:1 1 220px;min-width:0}
  .thumbrow .tx b{color:var(--fg)}

  .meta-grid{display:grid;grid-template-columns:82px 1fr auto;gap:7px 10px;align-items:start;
             background:var(--card);border:1px solid var(--line);border-radius:9px;padding:13px 15px;margin-bottom:16px}
  .k{color:var(--muted);font-size:12.5px;padding-top:3px}
  .v{font-size:13.5px;min-width:0;overflow-wrap:anywhere}
  .mini{border:1px solid var(--line);background:#fff;color:var(--fg);border-radius:5px;
        padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
  .mini:hover{border-color:var(--pen);color:var(--pen)}

  .toolbar{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
  .btn{border:1px solid var(--line);background:#fff;color:var(--fg);border-radius:8px;
       padding:9px 15px;font:inherit;font-size:13px;cursor:pointer;min-height:38px}
  .btn:hover{border-color:var(--pen)}
  .btn.primary{background:var(--pen);border-color:var(--pen);color:#fff}
  .btn.primary:hover{opacity:.9}
  .btn.active{background:var(--warn);border-color:var(--warn);color:#fff}
  .edited-badge{font-size:12px;color:var(--warn);align-self:center}

  #preview{background:#fff;border:1px solid var(--line);border-radius:10px;padding:26px 24px}
  #preview p{margin:0 0 1.15em;font-size:15px;line-height:1.95;white-space:pre-wrap}
  #preview p.h{font-weight:800;font-size:16px;margin:2.3em 0 1.1em;letter-spacing:-.02em}
  #preview p.h:first-child{margin-top:0}
  #preview p.tags-line{color:var(--muted);font-size:13px;margin-top:1.6em}
  .editable[contenteditable="true"]{outline:2px dashed var(--pen);outline-offset:4px;
                                    padding:4px;border-radius:6px}

  figure.cut{margin:1.9em 0}
  figure.cut img{width:100%;height:auto;display:block;border-radius:8px;background:var(--card)}
  figure.cut figcaption{font-size:12.5px;color:#6B6259;margin-top:8px;line-height:1.6}
  .cutlab{display:inline-block;font-size:11px;font-weight:700;color:var(--muted);
          border:1px solid var(--line);border-radius:4px;padding:1px 7px;margin-right:8px;
          font-family:ui-monospace,Menlo,monospace}
  .cutpair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media (max-width:560px){.cutpair{grid-template-columns:1fr}}
  .cutpair .one{min-width:0}
  .cutpair .who{font-size:11px;font-weight:700;color:var(--pen);margin-bottom:4px;
                font-family:ui-monospace,Menlo,monospace}
  .missing{border:1px dashed var(--pen);border-radius:8px;background:var(--pen-soft);
           padding:11px 14px;font-size:12.5px;color:var(--pen)}
  .prompt-inline{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;
                 background:var(--card);border:1px solid var(--line);border-radius:6px;
                 padding:8px 10px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;color:#6B6259}

  h2.sec{font-size:15px;margin:34px 0 12px;letter-spacing:-.025em}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.6}
  th{width:88px;color:var(--muted);font-weight:600;white-space:nowrap}
  td.copycol{width:56px;text-align:right}
  pre{background:#F2EBE0;border:1px solid var(--line);border-radius:8px;padding:12px 14px;
      font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;
      overflow-wrap:anywhere;margin:0 0 10px}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2B2621;color:#fff;
         padding:10px 20px;border-radius:9px;font-size:13px;opacity:0;pointer-events:none;
         transition:opacity .15s;z-index:40;max-width:90vw;text-align:center}
  .toast.show{opacity:1}

  /* 데스크톱: 상단바를 없애고 사이드바를 참조 파일처럼 항상 보이는 고정 패널로 */
  @media (min-width:860px){
    .topbar,.backdrop{display:none}
    body{display:flex;height:100vh}
    aside{position:static;transform:none;width:262px;flex:0 0 262px;height:100vh;z-index:auto}
    main{flex:1;overflow-y:auto;padding:26px 34px 90px}
  }
</style>
</head>
<body>
  <div class="topbar">
    <button type="button" class="nav-toggle-btn" id="nav-toggle" aria-label="원고 목록 열기">☰</button>
    <div class="topbar-title">원고 뷰어</div>
  </div>
  <div class="backdrop" id="backdrop"></div>
  <aside id="sidebar">
    <h1>우아아빠 · Blogspot</h1>
    <p class="meta">본문 복사 → Blogger 붙여넣기<br>생성 ${escapeHtml(generated)} (KST)</p>
    <div id="nav"></div>
  </aside>
  <main id="main"><div class="wrap" id="wrap"><div class="placeholder">${pageTopics.length === 0 ? "아직 준비된 원고가 없습니다." : "왼쪽에서 원고를 선택하세요."}</div></div></main>
  <div class="toast" id="toast"></div>

  <script id="manuscript-data" type="application/json">${safeJson(pageTopics)}</script>
  <script>
    var DATA = JSON.parse(document.getElementById("manuscript-data").textContent);
    var TODAY = ${safeJson(todayKst)};
    var wrap = document.getElementById("wrap");
    var toastEl = document.getElementById("toast");

    function setNavOpen(open) { document.body.classList.toggle("nav-open", open); }
    document.getElementById("nav-toggle").addEventListener("click", function () {
      setNavOpen(!document.body.classList.contains("nav-open"));
    });
    document.getElementById("backdrop").addEventListener("click", function () { setNavOpen(false); });

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      setTimeout(function () { toastEl.classList.remove("show"); }, 1500);
    }

    function esc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function copyText(text) {
      navigator.clipboard.writeText(text).then(
        function () { toast("복사했습니다"); },
        function () { toast("복사 실패 - 브라우저 권한을 확인하세요"); }
      );
    }

    /** rich HTML을 text/html + text/plain 둘 다로 복사한다. file://에서 Clipboard API가 막히면
     *  contenteditable 선택 영역 + execCommand("copy") 폴백, 그마저 안 되면 plain text만. */
    function copyRich(html, text) {
      if (navigator.clipboard && window.ClipboardItem) {
        try {
          var item = new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          });
          navigator.clipboard.write([item]).then(
            function () { toast("복사했습니다(서식 포함)"); },
            function () { copyRichFallback(html, text); }
          );
          return;
        } catch (e) { /* fall through */ }
      }
      copyRichFallback(html, text);
    }

    function copyRichFallback(html, text) {
      try {
        var box = document.createElement("div");
        box.setAttribute("contenteditable", "true");
        box.style.position = "fixed";
        box.style.left = "-9999px";
        box.innerHTML = html;
        document.body.appendChild(box);
        var range = document.createRange();
        range.selectNodeContents(box);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var ok = document.execCommand("copy");
        sel.removeAllRanges();
        document.body.removeChild(box);
        if (ok) { toast("복사했습니다(서식 포함)"); return; }
      } catch (e) { /* fall through */ }
      copyText(text);
    }

    function findTopic(jobId) {
      for (var i = 0; i < DATA.length; i++) if (DATA[i].jobId === jobId) return DATA[i];
      return null;
    }

    /** 본문 마커 index(1부터)에 해당하는 이미지들. A/B 비교면 provider별로 2장이 나온다. */
    function imagesFor(topic, n) {
      return (topic.images || []).filter(function (img) { return img.index === n; });
    }
    function imageBlocks(topic) {
      return topic.blocks.filter(function (b) { return b.type === "image"; });
    }
    /** 대표 이미지(가장 앞선 성공 이미지). 없으면 null. */
    function heroImage(topic) {
      var made = (topic.images || []).filter(function (img) { return img.url; });
      return made.length > 0 ? made[0] : null;
    }

    function editStorageKey(jobId) { return "manuscript-edit:" + jobId; }
    function loadEdits(jobId) {
      try { var raw = localStorage.getItem(editStorageKey(jobId)); return raw ? JSON.parse(raw) : null; }
      catch (e) { return null; }
    }
    function saveEdits(jobId, texts) {
      try { localStorage.setItem(editStorageKey(jobId), JSON.stringify(texts)); } catch (e) {}
    }
    function clearEdits(jobId) {
      try { localStorage.removeItem(editStorageKey(jobId)); } catch (e) {}
    }

    /** 태그를 본문 맨 끝에 붙는 해시태그 한 줄로 만든다("#태그1 #태그2 ..."). */
    function hashtagLine(tags) {
      return tags.map(function (t) { return "#" + t; }).join(" ");
    }

    /** 원고 안의 이미지 프롬프트를 전부 모아 한 번에 복사할 수 있는 텍스트로. 번호는 캡션 표와 맞춘다. */
    function promptPack(topic) {
      var parts = [];
      imageBlocks(topic).forEach(function (block, i) {
        var head = "[이미지 " + (i + 1) + "] " + block.description;
        var body = block.prompt ? block.prompt : "(프롬프트 미상 - 원본 원고를 확인하세요)";
        parts.push(head + "\\n" + body);
      });
      return parts.join("\\n\\n---\\n\\n");
    }

    function metaRow(label, value) {
      return '<div class="k">' + esc(label) + '</div>'
        + '<div class="v">' + esc(value) + '</div>'
        + '<button class="mini" data-copy="' + esc(value) + '">복사</button>';
    }

    function findEditable(i, field) {
      var sel = '.editable[data-block-index="' + i + '"]';
      sel += field ? '[data-field="' + field + '"]' : ':not([data-field])';
      return document.querySelector(sel);
    }

    function isListLine(line) { return /^\\s*[-*]\\s+/.test(line); }
    function stripListMarker(line) { return line.replace(/^\\s*[-*]\\s+/, ""); }

    // 굵게/이탤릭/링크 표기를 실제 태그로 - convertArticleToHtml.ts와 같은 규칙.
    function inlineHtml(text) {
      return esc(text)
        .replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>")
        .replace(/\\*(.+?)\\*/g, "<i>$1</i>")
        .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2">$1</a>');
    }

    function linesToHtml(lines) {
      if (lines.length > 0 && lines.every(isListLine)) {
        return "<ul>" + lines.map(function (l) { return "<li>" + inlineHtml(stripListMarker(l)) + "</li>"; }).join("") + "</ul>";
      }
      return "<p>" + lines.map(inlineHtml).join("<br>") + "</p>";
    }

    /** 블록 하나(수정 중이면 편집된 값)를 rich HTML로. 이미지는 collectRichHtml이 먼저 처리한다. */
    function blockHtml(block, i) {
      if (block.type === "heading") {
        var hEl = findEditable(i, "h"), bEl = findEditable(i, "b");
        var headingText = (hEl ? hEl.innerText : block.heading).trim();
        var bodyLines = (bEl ? bEl.innerText : block.body || "").split("\\n")
          .map(function (l) { return l.trim(); }).filter(Boolean);
        if (bodyLines.length === 0) return "<p><b>" + inlineHtml(headingText) + "</b></p>";
        if (bodyLines.every(isListLine)) {
          return '<p style="margin-bottom:0"><b>' + inlineHtml(headingText) + "</b></p>"
            + '<ul style="margin-top:0">' + bodyLines.map(function (l) { return "<li>" + inlineHtml(stripListMarker(l)) + "</li>"; }).join("") + "</ul>";
        }
        return "<p><b>" + inlineHtml(headingText) + "</b><br>" + bodyLines.map(inlineHtml).join("<br>") + "</p>";
      }
      var el = findEditable(i, null);
      var text = (el ? el.innerText : block.content).trim();
      return linesToHtml(text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean));
    }

    /** 블록 하나를 plain text로. 소제목-문단은 줄바꿈 1개, 블록 사이는 2개(writer.md §6). */
    function blockPlain(block, i) {
      if (block.type === "heading") {
        var hEl = findEditable(i, "h"), bEl = findEditable(i, "b");
        var headingText = (hEl ? hEl.innerText : block.heading).trim();
        var bodyText = (bEl ? bEl.innerText : block.body || "").trim();
        return bodyText ? headingText + "\\n" + bodyText : headingText;
      }
      var el = findEditable(i, null);
      return (el ? el.innerText : block.content).trim();
    }

    /** 본문 복사에 이미지 자리를 [[이미지 N]] 마커로 남긴다(붙여넣은 뒤 그 자리에 이미지를 올리고
     *  마커 줄을 지우는 용도) - 번호는 캡션 표/프롬프트 팩과 같은 순서다. */
    function collectRichHtml(topic) {
      var parts = [], n = 0;
      topic.blocks.forEach(function (block, i) {
        if (block.type === "image") { n += 1; parts.push("<p>[[이미지 " + n + "]]</p>"); return; }
        var html = blockHtml(block, i);
        if (html) parts.push(html);
      });
      if (topic.tags && topic.tags.length > 0) parts.push("<p>" + esc(hashtagLine(topic.tags)) + "</p>");
      return parts.join("\\n");
    }

    function collectPlainText(topic) {
      var parts = [], n = 0;
      topic.blocks.forEach(function (block, i) {
        if (block.type === "image") { n += 1; parts.push("[[이미지 " + n + "]]"); return; }
        var text = blockPlain(block, i);
        if (text) parts.push(text);
      });
      if (topic.tags && topic.tags.length > 0) parts.push(hashtagLine(topic.tags));
      return parts.join("\\n\\n");
    }

    /**
     * 네이버 배리에이션을 복사용 평문으로. collectPlainText를 재사용하지 **않는** 이유: 그쪽은
     * 화면의 편집 가능한 요소(findEditable)를 우선 읽는데, 화면에 그려진 건 Blogspot 본문이라
     * 네이버 본문을 복사해도 Blogspot 텍스트가 나온다(2026-09-18 작성 중 발견).
     * 여기서는 DOM을 보지 않고 블록 데이터만 쓴다.
     */
    function naverPlainText(naver) {
      var parts = [naver.title], n = 0;
      naver.blocks.forEach(function (block) {
        if (block.type === "image") { n += 1; parts.push("[[이미지 " + n + "]]"); return; }
        if (block.type === "heading") {
          var head = (block.heading || "").trim();
          var body = (block.body || "").trim();
          parts.push(body ? head + "\n" + body : head);
          return;
        }
        var text = (block.content || "").trim();
        if (text) parts.push(text);
      });
      if (naver.tags && naver.tags.length > 0) parts.push(hashtagLine(naver.tags));
      return parts.join("\n\n");
    }

    /** 이미지 한 장(또는 A/B 두 장)을 figure로. url이 없으면 사유와 프롬프트를 대신 보여준다. */
    function figureHtml(topic, n, block) {
      var shots = imagesFor(topic, n);
      var lab = '<span class="cutlab">' + n + '</span>';
      var caption = block.description || "캡션 없음";

      if (shots.length === 0) {
        var body = '<div class="missing">이미지 미생성 — 아래 프롬프트로 직접 만들어 이 자리에 넣으세요.</div>';
        if (block.prompt) body += '<div class="prompt-inline">' + esc(block.prompt) + '</div>';
        return '<figure class="cut">' + body + '<figcaption>' + lab + esc(caption) + '</figcaption></figure>';
      }

      var usable = shots.filter(function (s) { return s.url; });
      if (usable.length === 0) {
        var why = shots[0].error ? esc(shots[0].error) : "생성 실패";
        return '<figure class="cut"><div class="missing">이미지 생성 실패 — ' + why + '</div>'
          + '<figcaption>' + lab + esc(caption) + '</figcaption></figure>';
      }

      var inner;
      if (usable.length === 1) {
        inner = '<img src="' + esc(usable[0].url) + '" alt="' + esc(caption) + '" loading="lazy">';
      } else {
        // A/B 비교: provider별로 나란히. 어느 쪽이 나은지 보고 고르는 게 이 화면의 목적이다.
        inner = '<div class="cutpair">' + usable.map(function (s) {
          return '<div class="one"><div class="who">' + esc(s.provider || "?") + '</div>'
            + '<img src="' + esc(s.url) + '" alt="' + esc(caption) + '" loading="lazy"></div>';
        }).join("") + '</div>';
      }
      return '<figure class="cut">' + inner + '<figcaption>' + lab + esc(caption) + '</figcaption></figure>';
    }

    function render(jobId) {
      var topic = findTopic(jobId);
      if (!topic) return;

      document.querySelectorAll(".navbtn").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-job-id") === jobId);
      });
      history.replaceState(null, "", "#" + jobId);

      var edits = loadEdits(jobId);
      var blocks = imageBlocks(topic);
      var madeCount = (topic.images || []).filter(function (i) { return i.url; }).length;

      var sub = [esc(topic.date), esc(topic.categoryLabel), "본문 " + topic.charCount + "자(공백 제외)"];
      sub.push(blocks.length > 0
        ? "이미지 " + blocks.length + "자리 · 생성 " + madeCount + "장"
        : '<span class="bad">이미지 자리 없음</span>');
      sub.push("<code>" + esc(topic.jobId.slice(0, 8)) + "</code>");

      var h = "";
      h += '<div class="cat-badge">' + esc(topic.categoryLabel) + '</div>';
      h += '<div class="doc-title">' + esc(topic.title || topic.keyword) + '</div>';
      h += '<div class="doc-sub">' + sub.join(" · ") + '</div>';

      // 2026-09-16부터 승인 시 Blogspot 초안이 자동 저장된다(제목·본문·이미지·라벨·댓글 설정까지).
      // 그래서 안내는 "전부 복사해 붙여넣기"가 아니라 "초안에서 무엇을 더 채워야 하는가"여야 한다.
      // 퍼머링크와 검색 설명은 Blogger API로 설정할 수 없고(2026-09-16 실측), 웹 검색 마커 자리의
      // 이미지도 사람이 넣어야 해서 - 그 셋만 모아 아래 "발행 전 채울 것"에 띄운다.
      var todo = [];
      if (topic.slug) {
        todo.push({ label: "퍼머링크", value: topic.slug, where: "글 설정 → 퍼머링크 → 맞춤 퍼머링크" });
      }
      if (topic.searchDescription) {
        todo.push({ label: "검색 설명", value: topic.searchDescription, where: "글 설정 → 검색 설명" });
      }
      // 본문에 실제로 박히지 못한 이미지 자리(확정 1장이 아닌 곳) - 발행 코드와 같은 기준이다.
      var unfilled = [];
      blocks.forEach(function (block, i) {
        var n = i + 1;
        if (imagesFor(topic, n).filter(function (s) { return s.url; }).length !== 1) {
          unfilled.push({ n: n, description: block.description, prompt: block.prompt });
        }
      });

      h += '<div class="hint"><b>초안이 Blogspot에 자동 저장됩니다</b>'
         + ' — 제목 · 본문 · 이미지 · 라벨 · 댓글 비허용까지 들어갑니다.'
         + ' 아래 항목만 Blogger 편집 화면에서 직접 채운 뒤 발행하세요.</div>';

      if (todo.length > 0 || unfilled.length > 0) {
        h += '<h2 class="sec">✍️ 발행 전 채울 것 ' + (todo.length + unfilled.length) + '건</h2>';
        h += '<div class="meta-grid">';
        todo.forEach(function (item) {
          h += '<div class="k">' + esc(item.label) + '</div>';
          h += '<div class="v">' + esc(item.value)
             + '<br><span style="color:#8A7F72;font-size:12px">' + esc(item.where) + '</span></div>';
          h += '<button class="mini" data-copy="' + esc(item.value) + '">복사</button>';
        });
        unfilled.forEach(function (item) {
          h += '<div class="k">이미지 ' + item.n + '</div>';
          h += '<div class="v">' + esc(item.description)
             + '<br><span style="color:#8A7F72;font-size:12px">'
             + (item.prompt ? '검색어: ' + esc(item.prompt) : '검색어 미상 - 본문 마커 참고')
             + '</span></div>';
          h += item.prompt
            ? '<button class="mini" data-copy="' + esc(item.prompt) + '">검색어</button>'
            : '<span></span>';
        });
        h += '</div>';
      } else {
        h += '<div class="hint">✅ 추가로 채울 항목이 없습니다 — 초안을 확인하고 바로 발행하면 됩니다.</div>';
      }

      var hero = heroImage(topic);
      if (hero) {
        h += '<div class="thumbrow">';
        h += '<img src="' + esc(hero.url) + '" alt="' + esc(hero.description) + '">';
        h += '<div class="tx"><b>대표 이미지</b><br>' + esc(hero.description)
           + '<br><span style="color:var(--pen)">' + esc(hero.provider || "") + '</span> · '
           + esc(hero.fileName) + '</div>';
        h += '</div>';
      }

      h += '<div class="meta-grid">';
      h += metaRow("제목", topic.title || topic.keyword);
      if (topic.searchDescription) h += metaRow("검색 설명", topic.searchDescription);
      if (topic.slug) h += metaRow("슬러그", topic.slug);
      if (topic.tags && topic.tags.length) h += metaRow("태그", topic.tags.join(", "));
      h += '</div>';

      h += '<div class="toolbar">';
      h += '<button class="btn primary" id="c-body">📋 본문 복사 (서식 유지)</button>';
      // 2026-09-18: "본문 평문 복사"를 네이버용으로 바꿨다(사용자 요청). 평문 복사는 Blogspot
      // 초안이 자동 저장되면서 쓸 일이 없어졌고, 네이버는 그 자리에 붙여넣을 판이 따로 필요하다.
      if (topic.naver) {
        h += '<button class="btn" id="c-naver">📗 네이버용 원고 복사</button>';
      } else {
        // 왜 없는지 알려준다 - 버튼이 그냥 사라지면 고장인지 미생성인지 구분이 안 된다.
        h += '<span class="doc-sub" style="align-self:center">네이버 배리에이션 없음</span>';
      }
      if (blocks.length > 0) h += '<button class="btn" id="c-prompt">🖼 이미지 프롬프트 복사(' + blocks.length + '장)</button>';
      h += '<button class="btn" id="edit-toggle">✏️ 수정</button>';
      if (edits) h += '<button class="btn" id="revert">↩️ 원본으로</button><span class="edited-badge">이 브라우저에서 수정됨</span>';
      h += '</div>';

      if (blocks.length > 0) {
        h += '<h2 class="sec">캡션 ' + blocks.length + '줄</h2><table><tbody>';
        blocks.forEach(function (block, i) {
          var n = i + 1;
          var shots = imagesFor(topic, n);
          var file = shots.length > 0 ? shots[0].fileName : "";
          h += '<tr><th>이미지 ' + n + '</th><td>' + esc(block.description || "—")
             + (file ? '<br><span style="color:var(--muted);font-size:12px">' + esc(file) + '</span>' : "")
             + '</td><td class="copycol"><button class="mini" data-copy="' + esc(block.description) + '">복사</button></td></tr>';
        });
        h += '</tbody></table>';
      }

      h += '<div id="preview">';
      var n = 0;
      topic.blocks.forEach(function (block, i) {
        if (block.type === "image") {
          n += 1;
          h += figureHtml(topic, n, block);
        } else if (block.type === "heading") {
          var headText = edits && edits[i + ":h"] != null ? edits[i + ":h"] : block.heading;
          h += '<p class="h editable" data-block-index="' + i + '" data-field="h">' + esc(headText) + '</p>';
          if (block.body) {
            var headBody = edits && edits[i + ":b"] != null ? edits[i + ":b"] : block.body;
            h += '<p class="editable" data-block-index="' + i + '" data-field="b">' + esc(headBody) + '</p>';
          }
        } else {
          var text = edits && edits[i] != null ? edits[i] : block.content;
          h += '<p class="editable" data-block-index="' + i + '">' + esc(text) + '</p>';
        }
      });
      if (topic.tags && topic.tags.length > 0) {
        h += '<p class="tags-line">' + esc(hashtagLine(topic.tags)) + '</p>';
      }
      h += '</div>';

      if (blocks.length > 0) {
        h += '<h2 class="sec">이미지 생성 프롬프트</h2><pre>' + esc(promptPack(topic)) + '</pre>';
      }

      wrap.innerHTML = h;
      wire(topic);
      document.getElementById("main").scrollTop = 0;
      window.scrollTo(0, 0);
    }

    function currentTexts() {
      var texts = {};
      document.querySelectorAll(".editable").forEach(function (el) {
        var key = el.dataset.blockIndex + (el.dataset.field ? ":" + el.dataset.field : "");
        texts[key] = el.innerText;
      });
      return texts;
    }

    function wire(topic) {
      wrap.querySelectorAll("[data-copy]").forEach(function (b) {
        b.addEventListener("click", function () { copyText(b.getAttribute("data-copy")); });
      });

      document.getElementById("c-body").addEventListener("click", function () {
        copyRich(collectRichHtml(topic), collectPlainText(topic));
      });
      var naverBtn = document.getElementById("c-naver");
      if (naverBtn) {
        naverBtn.addEventListener("click", function () {
          // 제목·태그가 Blogspot과 다르므로 제목까지 함께 복사한다. 이미지 자리는 [[이미지 N]]으로
          // 남고 번호가 Blogspot과 같아, 아래 캡션 표를 그대로 보고 이미지를 채우면 된다.
          copyText(naverPlainText(topic.naver));
        });
      }
      var promptBtn = document.getElementById("c-prompt");
      if (promptBtn) promptBtn.addEventListener("click", function () { copyText(promptPack(topic)); });

      var editing = false;
      var editBtn = document.getElementById("edit-toggle");
      editBtn.addEventListener("click", function () {
        editing = !editing;
        editBtn.classList.toggle("active", editing);
        editBtn.textContent = editing ? "✅ 편집 종료" : "✏️ 수정";
        document.querySelectorAll(".editable").forEach(function (el) {
          el.setAttribute("contenteditable", editing ? "true" : "false");
        });
        if (!editing) { saveEdits(topic.jobId, currentTexts()); render(topic.jobId); }
      });

      var revertBtn = document.getElementById("revert");
      if (revertBtn) revertBtn.addEventListener("click", function () {
        clearEdits(topic.jobId);
        render(topic.jobId);
      });
    }

    // ---- 좌측 트리: 날짜 그룹 -> 주제 (참조 파일의 시리즈 그룹 구조와 같다) ----
    var nav = document.getElementById("nav");
    if (DATA.length === 0) {
      nav.innerHTML = '<div class="empty">아직 준비된 원고가 없습니다.</div>';
    } else {
      var curDate = null, curItems = null, openedOne = false;
      DATA.forEach(function (topic, i) {
        if (topic.date !== curDate) {
          curDate = topic.date;
          var count = DATA.filter(function (t) { return t.date === curDate; }).length;
          // 오늘 날짜 그룹만 펼친다. 오늘 준비된 원고가 없으면 첫(=가장 최근) 그룹을 펼친다.
          var shouldOpen = curDate === TODAY || (!openedOne && i === 0);
          if (shouldOpen) openedOne = true;
          var group = document.createElement("div");
          group.className = "navgroup" + (shouldOpen ? " open" : "");
          var title = document.createElement("div");
          title.className = "navgroup-title";
          title.innerHTML = '<span>' + esc(curDate) + '<span class="cnt">(' + count + ')</span></span>'
                          + '<span class="arrow">▶</span>';
          var items = document.createElement("div");
          items.className = "navgroup-items";
          title.onclick = function () { group.classList.toggle("open"); };
          group.appendChild(title);
          group.appendChild(items);
          nav.appendChild(group);
          curItems = items;
        }
        var b = document.createElement("button");
        b.className = "navbtn";
        b.setAttribute("data-job-id", topic.jobId);
        b.textContent = topic.keyword;
        b.onclick = function () { render(topic.jobId); setNavOpen(false); };
        curItems.appendChild(b);
      });
    }

    // URL 해시(#jobId)가 있으면 그 원고를 바로 연다(텔레그램 딥링크). 채널이 붙은 옛 링크
    // (#jobId:blogspot)도 앞부분만 떼어 받아준다. 없으면 첫 주제.
    (function openInitial() {
      var hash = location.hash.replace(/^#/, "").split(":")[0];
      if (hash && findTopic(hash)) {
        var btn = document.querySelector('.navbtn[data-job-id="' + hash + '"]');
        if (btn && btn.parentNode && btn.parentNode.parentNode) btn.parentNode.parentNode.classList.add("open");
        render(hash);
        return;
      }
      if (DATA.length > 0) render(DATA[0].jobId);
    })();
  </script>
</body>
</html>
`;
}
