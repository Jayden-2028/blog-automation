// manifest.json -> 열람용 index.html (날짜 -> 주제 -> 채널 3개 트리). file://로 여는 정적 페이지라
// 서버·번들러가 없다 - scripts/statusDashboard.ts와 같은 관례(문자열 템플릿 -> writeFile)를 따른다.
//
// 원고 본문은 Node에서 미리 parseManuscriptBlocks로 텍스트/이미지 블록으로 나눠 JSON에 담는다.
// 브라우저 쪽 JS가 같은 정규식을 다시 구현하면 화면에 보이는 것과 "복사" 버튼이 복사하는 것이
// 어긋날 위험이 있어, 파싱은 한 곳(parseManuscriptBlocks)에서만 한다.
//
// 수정(편집) 결과는 브라우저 localStorage에만 남는다(2026-09-05 사용자 결정) - 로컬 원고 파일은
// 항상 원본 그대로다. 정적 파일이라 서버에 다시 쓸 방법이 없다 - 나중에 그게 필요해지면 작은 로컬
// 서버가 있어야 한다(이번 범위 밖).

import { parseManuscriptBlocks } from "./parseManuscriptBlocks.js";
import type { ManuscriptBlock } from "./parseManuscriptBlocks.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";

const CHANNEL_LABEL: Record<ManuscriptChannel, string> = {
  naver: "🟢 네이버",
  tistory: "🟠 티스토리",
  blogspot: "🔵 Blogspot",
};

type PageChannel = {
  channel: ManuscriptChannel;
  title: string;
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  blocks: ManuscriptBlock[];
};

type PageTopic = {
  jobId: string;
  keyword: string;
  category: string | null;
  date: string;
  channels: PageChannel[];
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
  return {
    jobId: entry.jobId,
    keyword: entry.keyword,
    category: entry.category,
    date: entry.date,
    channels: entry.channels.map((c) => ({
      channel: c.channel,
      title: c.title,
      searchDescription: c.searchDescription,
      slug: c.slug,
      tags: c.tags,
      blocks: parseManuscriptBlocks(c.body, c.imagePrompts),
    })),
  };
}

export function renderManuscriptPage(manifest: ManuscriptManifest, generatedAt: Date = new Date()): string {
  const topics = [...manifest.topics].sort((a, b) => b.date.localeCompare(a.date) || b.readyAt.localeCompare(a.readyAt));
  const pageTopics = topics.map(toPageTopic);

  const days = new Map<string, PageTopic[]>();
  for (const topic of pageTopics) {
    const list = days.get(topic.date) ?? [];
    list.push(topic);
    days.set(topic.date, list);
  }

  const generated = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(generatedAt);

  // kstDateString(prepareChannelManuscripts.ts)과 같은 포맷(en-CA -> YYYY-MM-DD)으로 오늘 날짜를
  // 계산해, 그 날짜 그룹만 기본으로 펼쳐두고 지난 날짜는 접어 둔다(목록이 길어질수록 오늘 것부터
  // 바로 보이게 - 2026-09-15 사용자 요청). 오늘 준비된 원고가 아직 없는 날은 대신 가장 최근 날짜를
  // 펼쳐서, 페이지를 열자마자 전부 접혀 비어 보이는 것을 막는다(topics가 date desc 정렬이라
  // days의 첫 키가 최신 날짜).
  const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(generatedAt);
  const defaultOpenDate = days.has(todayKst) ? todayKst : [...days.keys()][0];

  const treeHtml =
    days.size === 0
      ? `<div class="empty">아직 준비된 원고가 없습니다.</div>`
      : [...days.entries()]
          .map(
            ([date, topicsOfDay]) => `
      <details class="day"${date === defaultOpenDate ? " open" : ""}>
        <summary>${escapeHtml(date)} <span class="count">${topicsOfDay.length}</span></summary>
        ${topicsOfDay
          .map(
            (topic) => `
        <details class="topic" data-job-id="${escapeHtml(topic.jobId)}" open>
          <summary>${escapeHtml(topic.keyword)}</summary>
          <ul class="channels">
            ${topic.channels
              .map(
                (c) =>
                  `<li><button type="button" class="channel-btn" data-job-id="${escapeHtml(topic.jobId)}" data-channel="${c.channel}">${CHANNEL_LABEL[c.channel]}</button></li>`
              )
              .join("\n            ")}
          </ul>
        </details>`
          )
          .join("\n")}
      </details>`
          )
          .join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>채널별 원고</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --card:#f6f8fa; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#161b22; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif; }

  /* 모바일 상단바(햄버거 메뉴) - 데스크톱에서는 숨김 */
  .topbar { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line);
            position:sticky; top:0; background:var(--bg); z-index:20; }
  .topbar-title { font-weight:700; font-size:15px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nav-toggle-btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px;
                    width:40px; height:40px; min-width:40px; font-size:18px; line-height:1; cursor:pointer; }
  .backdrop { display:none; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:29; }
  body.nav-open .backdrop { display:block; }

  /* 목록(아사이드) - 모바일에서는 왼쪽에서 슬라이드되는 드로어, 데스크톱에서는 고정 사이드바 */
  aside { position:fixed; top:0; left:0; bottom:0; width:85vw; max-width:320px; background:var(--bg);
          border-right:1px solid var(--line); overflow-y:auto; padding:16px; z-index:30;
          transform:translateX(-100%); transition:transform .2s ease; }
  body.nav-open aside { transform:translateX(0); }
  aside h1 { font-size:15px; margin:0 0 4px; }
  aside .meta { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .empty { color:var(--muted); padding:16px; }
  details.day { margin-bottom:6px; }
  details.day > summary { font-weight:700; cursor:pointer; padding:8px 4px; }
  details.day .count { color:var(--muted); font-weight:400; font-size:12px; }
  details.topic { margin:2px 0 2px 12px; }
  details.topic > summary { cursor:pointer; padding:8px 4px; font-size:13.5px; }
  ul.channels { list-style:none; margin:0 0 6px 14px; padding:0; }
  .channel-btn { display:block; width:100%; text-align:left; background:none; border:none; color:var(--fg);
                 padding:10px 8px; border-radius:6px; cursor:pointer; font-size:14px; }
  .channel-btn:hover { background:var(--card); }
  .channel-btn.active { background:var(--accent); color:#fff; }

  main { padding:18px 16px 48px; max-width:720px; margin:0 auto; }
  .placeholder { color:var(--muted); padding:8px; }
  .doc-title { font-size:19px; line-height:1.4; font-weight:700; margin:0 0 14px; }

  .meta-grid { display:flex; flex-direction:column; gap:12px;
               background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:18px; }
  .meta-row-head { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .meta-grid .k { color:var(--muted); font-size:12.5px; }
  .meta-grid .v { font-size:14.5px; word-break:break-word; margin-top:3px; }
  .mini-copy { border:1px solid var(--line); background:var(--bg); color:var(--fg); border-radius:6px;
               padding:5px 10px; font-size:12.5px; cursor:pointer; flex:0 0 auto; }
  .mini-copy:hover { border-color:var(--accent); }

  .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px;
         padding:10px 16px; font-size:14px; cursor:pointer; min-height:40px; }
  .btn:hover { border-color:var(--accent); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.active { background:#b45309; border-color:#b45309; color:#fff; }
  .edited-badge { font-size:12px; color:#b45309; margin-left:2px; align-self:center; }

  .body-block { margin-bottom:16px; }
  .text-block { white-space:pre-wrap; }
  .heading-block { font-weight:700; font-size:16.5px; margin-bottom:0; white-space:pre-wrap; }
  .editable[contenteditable="true"] { outline:2px dashed var(--accent); outline-offset:4px; padding:4px; border-radius:6px; }
  .image-card { border:1px dashed var(--line); border-radius:10px; padding:12px; background:var(--card); margin:1.6em 0; }
  .image-card .label { font-size:12px; color:var(--muted); margin-bottom:4px; }
  .image-card .desc { font-size:13.5px; margin-bottom:8px; }
  .image-card .prompt { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px;
                         background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px;
                         white-space:pre-wrap; overflow-wrap:break-word; }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1f2328; color:#fff;
           padding:10px 18px; border-radius:8px; font-size:13.5px; opacity:0; pointer-events:none; transition:opacity .15s;
           max-width:90vw; text-align:center; }
  .toast.show { opacity:1; }

  /* 이미지 프롬프트 팩 - 원고 안의 이미지 프롬프트를 전부 모아 한 번에 복사(이미지 생성 도구에 붙여넣기용). */
  .sec-title { font-size:15px; font-weight:700; margin:32px 0 10px; }
  .prompt-pack { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; line-height:1.7;
                 background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px;
                 white-space:pre-wrap; overflow-wrap:break-word; overflow-x:auto; }

  /* 데스크톱: 상단바 없애고 사이드바를 항상 보이는 고정 패널로 */
  @media (min-width: 860px) {
    .topbar, .backdrop { display:none; }
    body { display:flex; min-height:100vh; }
    aside { position:static; transform:none; width:300px; flex:0 0 300px; height:100vh; z-index:auto; }
    main { flex:1; height:100vh; overflow-y:auto; padding:28px 40px; max-width:800px; margin:0; }
  }
</style>
</head>
<body>
  <div class="topbar">
    <button type="button" class="nav-toggle-btn" id="nav-toggle" aria-label="원고 목록 열기">☰</button>
    <div class="topbar-title">채널별 원고</div>
  </div>
  <div class="backdrop" id="backdrop"></div>
  <aside id="sidebar">
    <h1>채널별 원고</h1>
    <div class="meta">생성 ${escapeHtml(generated)} (KST)</div>
    ${treeHtml}
  </aside>
  <main id="main">
    <div class="placeholder">${days.size === 0 ? "" : "메뉴(☰)에서 주제 → 채널을 선택하세요."}</div>
  </main>
  <div class="toast" id="toast"></div>

  <script id="manuscript-data" type="application/json">${safeJson(pageTopics)}</script>
  <script>
    var DATA = JSON.parse(document.getElementById("manuscript-data").textContent);
    var CHANNEL_LABEL = ${safeJson(CHANNEL_LABEL)};
    var main = document.getElementById("main");
    var toastEl = document.getElementById("toast");
    var current = null; // { jobId, channel }

    // 모바일 목록 드로어 - 데스크톱(min-width:860px)에서는 CSS가 topbar/backdrop을 숨기므로 무해하다.
    function setNavOpen(open) {
      document.body.classList.toggle("nav-open", open);
    }
    document.getElementById("nav-toggle").addEventListener("click", function () {
      setNavOpen(!document.body.classList.contains("nav-open"));
    });
    document.getElementById("backdrop").addEventListener("click", function () { setNavOpen(false); });

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      setTimeout(function () { toastEl.classList.remove("show"); }, 1400);
    }

    function copyText(text) {
      navigator.clipboard.writeText(text).then(
        function () { toast("복사했습니다"); },
        function () { toast("복사 실패 - 브라우저 권한을 확인하세요"); }
      );
    }

    function findTopicChannel(jobId, channel) {
      var topic = DATA.find(function (t) { return t.jobId === jobId; });
      if (!topic) return null;
      var ch = topic.channels.find(function (c) { return c.channel === channel; });
      if (!ch) return null;
      return { topic: topic, channel: ch };
    }

    function editStorageKey(jobId, channel) {
      return "manuscript-edit:" + jobId + ":" + channel;
    }

    function loadEdits(jobId, channel) {
      try {
        var raw = localStorage.getItem(editStorageKey(jobId, channel));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function saveEdits(jobId, channel, texts) {
      try { localStorage.setItem(editStorageKey(jobId, channel), JSON.stringify(texts)); } catch (e) {}
    }

    function clearEdits(jobId, channel) {
      try { localStorage.removeItem(editStorageKey(jobId, channel)); } catch (e) {}
    }

    function escapeHtmlJs(value) {
      return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function renderChannel(jobId, channel) {
      var found = findTopicChannel(jobId, channel);
      if (!found) return;
      current = { jobId: jobId, channel: channel };

      document.querySelectorAll(".channel-btn").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.jobId === jobId && btn.dataset.channel === channel);
      });

      var topic = found.topic, ch = found.channel;
      var savedEdits = loadEdits(jobId, channel);
      var editing = false;
      // 텔레그램 알림 링크가 방금 준비된 원고로 바로 열리도록 해시에 남긴다(jobId:channel).
      history.replaceState(null, "", "#" + jobId + ":" + channel);

      var html = "";
      html += '<div class="doc-title">' + escapeHtmlJs(topic.keyword) + " — " + CHANNEL_LABEL[channel] + "</div>";
      html += '<div class="meta-grid">';
      html += metaRow("제목", ch.title);
      if (ch.searchDescription) html += metaRow("검색 설명", ch.searchDescription);
      if (ch.slug) html += metaRow("슬러그", ch.slug);
      if (ch.tags && ch.tags.length) html += metaRow("태그", ch.tags.join(", "));
      html += "</div>";

      var imageBlocks = ch.blocks.filter(function (b) { return b.type === "image"; });

      html += '<div class="toolbar">';
      html += '<button type="button" class="btn" id="edit-toggle">✏️ 수정</button>';
      html += '<button type="button" class="btn primary" id="copy-body">📋 복사</button>';
      if (imageBlocks.length > 0) html += '<button type="button" class="btn" id="copy-image-pack">🖼 이미지 프롬프트 전체 복사(' + imageBlocks.length + '장)</button>';
      if (savedEdits) html += '<button type="button" class="btn" id="revert">↩️ 원본으로 되돌리기</button>';
      html += savedEdits ? '<span class="edited-badge">이 브라우저에서 수정됨</span>' : "";
      html += "</div>";

      html += '<div id="blocks">';
      var imageIndex = 0;
      ch.blocks.forEach(function (block, i) {
        if (block.type === "image") {
          imageIndex += 1;
          html += '<div class="body-block image-card">';
          html += '<div class="label">🖼 이미지 ' + imageIndex + ' 위치</div>';
          html += '<div class="desc">' + escapeHtmlJs(block.description) + "</div>";
          if (block.prompt) {
            html += '<div class="prompt">' + escapeHtmlJs(block.prompt) + "</div>";
            html += '<button type="button" class="mini-copy copy-prompt" data-text="' + escapeHtmlJs(block.prompt) + '" style="margin-top:8px;">프롬프트 복사</button>';
          } else {
            html += '<div class="prompt" style="color:var(--muted);">프롬프트 미상 - 원본 원고(drafts/*.md)를 확인하세요.</div>';
          }
          html += "</div>";
        } else if (block.type === "heading") {
          var headingText = savedEdits && savedEdits[i + ":h"] != null ? savedEdits[i + ":h"] : block.heading;
          html += '<div class="body-block heading-block editable" data-block-index="' + i + '" data-field="h">' + escapeHtmlJs(headingText) + "</div>";
          if (block.body) {
            var headingBody = savedEdits && savedEdits[i + ":b"] != null ? savedEdits[i + ":b"] : block.body;
            html += '<div class="body-block text-block editable" data-block-index="' + i + '" data-field="b">' + escapeHtmlJs(headingBody) + "</div>";
          }
        } else {
          var text = savedEdits && savedEdits[i] != null ? savedEdits[i] : block.content;
          html += '<div class="body-block text-block editable" data-block-index="' + i + '">' + escapeHtmlJs(text) + "</div>";
        }
      });
      html += "</div>";

      if (imageBlocks.length > 0) {
        html += '<h2 class="sec-title">🖼️ 이미지 생성 프롬프트 팩(' + imageBlocks.length + '장)</h2>';
        html += '<div class="prompt-pack">' + escapeHtmlJs(imagePromptPack(ch)) + '</div>';
      }

      main.innerHTML = html;
      wireChannelEvents(topic, ch);
    }

    /** 원고 안의 이미지 프롬프트를 전부 모아 한 번에 복사할 수 있는 텍스트로 만든다 - ChatGPT/Gemini
     *  등 이미지 생성 도구에 한 번에 붙여넣어 순서대로 만들 수 있게. 번호는 image-card 라벨과 맞춘다. */
    function imagePromptPack(ch) {
      var n = 0;
      var parts = [];
      ch.blocks.forEach(function (block) {
        if (block.type !== "image") return;
        n += 1;
        var head = "[이미지 " + n + "] " + block.description;
        var body = block.prompt ? block.prompt : "(프롬프트 미상 - 원본 원고를 확인하세요)";
        parts.push(head + "\\n" + body);
      });
      return parts.join("\\n\\n---\\n\\n");
    }

    function metaRow(label, value) {
      return '<div class="meta-row">' +
        '<div class="meta-row-head"><span class="k">' + label + '</span>' +
        '<button type="button" class="mini-copy copy-field" data-text="' + escapeHtmlJs(value) + '">복사</button></div>' +
        '<div class="v">' + escapeHtmlJs(value) + '</div>' +
        '</div>';
    }

    function currentBlockTexts() {
      var texts = {};
      document.querySelectorAll(".editable").forEach(function (el) {
        var key = el.dataset.blockIndex + (el.dataset.field ? ":" + el.dataset.field : "");
        texts[key] = el.innerText;
      });
      return texts;
    }

    function findEditable(i, field) {
      var sel = '.editable[data-block-index="' + i + '"]';
      sel += field ? '[data-field="' + field + '"]' : ':not([data-field])';
      return document.querySelector(sel);
    }

    function isListLine(line) { return /^\\s*[-*]\\s+/.test(line); }
    function stripListMarker(line) { return line.replace(/^\\s*[-*]\\s+/, ""); }

    // 굵게/이탤릭/링크 표기를 실제 태그로 바꾼다 - convertArticleToHtml.ts와 같은 규칙.
    function inlineHtml(text) {
      return escapeHtmlJs(text)
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

    /** 블록 하나(수정 중이면 편집된 값)를 rich HTML로. 이미지 카드는 복사 대상에서 뺀다. */
    function blockHtml(block, i) {
      if (block.type === "image") return "";
      if (block.type === "heading") {
        var hEl = findEditable(i, "h"), bEl = findEditable(i, "b");
        var headingText = (hEl ? hEl.innerText : block.heading).trim();
        var bodyLines = (bEl ? bEl.innerText : block.body || "").split("\\n").map(function (l) { return l.trim(); }).filter(Boolean);
        if (bodyLines.length === 0) return "<p><b>" + inlineHtml(headingText) + "</b></p>";
        if (bodyLines.every(isListLine)) {
          return (
            '<p style="margin-bottom:0"><b>' + inlineHtml(headingText) + "</b></p>" +
            '<ul style="margin-top:0">' + bodyLines.map(function (l) { return "<li>" + inlineHtml(stripListMarker(l)) + "</li>"; }).join("") + "</ul>"
          );
        }
        return "<p><b>" + inlineHtml(headingText) + "</b><br>" + bodyLines.map(inlineHtml).join("<br>") + "</p>";
      }
      var el = findEditable(i, null);
      var text = (el ? el.innerText : block.content).trim();
      return linesToHtml(text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean));
    }

    /** 블록 하나를 plain text로(이미지 제외). 소제목-문단은 줄바꿈 1개, 블록 사이는 2개(writer.md §6). */
    function blockPlainText(block, i) {
      if (block.type === "image") return null;
      if (block.type === "heading") {
        var hEl = findEditable(i, "h"), bEl = findEditable(i, "b");
        var headingText = (hEl ? hEl.innerText : block.heading).trim();
        var bodyText = (bEl ? bEl.innerText : block.body || "").trim();
        return bodyText ? headingText + "\\n" + bodyText : headingText;
      }
      var el = findEditable(i, null);
      return (el ? el.innerText : block.content).trim();
    }

    function collectRichHtml(ch) {
      var parts = [];
      ch.blocks.forEach(function (block, i) {
        var html = blockHtml(block, i);
        if (html) parts.push(html);
      });
      return parts.join("\\n");
    }

    function collectPlainText(ch) {
      var parts = [];
      ch.blocks.forEach(function (block, i) {
        var text = blockPlainText(block, i);
        if (text) parts.push(text);
      });
      return parts.join("\\n\\n");
    }

    /** rich HTML을 text/html + text/plain 둘 다로 복사한다. file:// 등에서 Clipboard API가 막히면
     *  contenteditable에 선택 영역을 만들어 execCommand("copy")로 폴백, 그마저 안 되면 plain text만. */
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
        var container = document.createElement("div");
        container.setAttribute("contenteditable", "true");
        container.style.position = "fixed";
        container.style.left = "-9999px";
        container.innerHTML = html;
        document.body.appendChild(container);
        var range = document.createRange();
        range.selectNodeContents(container);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var ok = document.execCommand("copy");
        sel.removeAllRanges();
        document.body.removeChild(container);
        if (ok) { toast("복사했습니다(서식 포함)"); return; }
      } catch (e) { /* fall through to plain text */ }
      copyText(text);
    }

    function wireChannelEvents(topic, ch) {
      var jobId = topic.jobId, channel = ch.channel;

      main.querySelectorAll(".copy-field, .copy-prompt").forEach(function (btn) {
        btn.addEventListener("click", function () { copyText(btn.dataset.text); });
      });

      var editToggle = document.getElementById("edit-toggle");
      var editing = false;
      editToggle.addEventListener("click", function () {
        editing = !editing;
        editToggle.classList.toggle("active", editing);
        editToggle.textContent = editing ? "✅ 편집 종료" : "✏️ 수정";
        document.querySelectorAll(".editable").forEach(function (el) {
          el.setAttribute("contenteditable", editing ? "true" : "false");
        });
        if (!editing) {
          var texts = currentBlockTexts();
          saveEdits(jobId, channel, texts);
          renderChannel(jobId, channel);
        }
      });

      var revertBtn = document.getElementById("revert");
      if (revertBtn) {
        revertBtn.addEventListener("click", function () {
          clearEdits(jobId, channel);
          renderChannel(jobId, channel);
        });
      }

      document.getElementById("copy-body").addEventListener("click", function () {
        copyRich(collectRichHtml(ch), collectPlainText(ch));
      });

      var imagePackBtn = document.getElementById("copy-image-pack");
      if (imagePackBtn) {
        imagePackBtn.addEventListener("click", function () {
          copyText(imagePromptPack(ch));
        });
      }
    }

    document.querySelectorAll(".channel-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        renderChannel(btn.dataset.jobId, btn.dataset.channel);
        setNavOpen(false); // 모바일에서 채널 선택 시 드로어를 닫아 바로 본문을 보여준다.
        main.scrollTop = 0;
      });
    });

    // URL 해시(#jobId:channel)가 있으면 그 원고를 바로 연다(텔레그램 링크 딥링크).
    // 없거나 못 찾으면 첫 주제의 첫 채널을 기본으로 연다.
    (function openInitialChannel() {
      var hash = location.hash.replace(/^#/, "");
      if (hash) {
        var parts = hash.split(":");
        if (parts.length === 2 && findTopicChannel(parts[0], parts[1])) {
          renderChannel(parts[0], parts[1]);
          return;
        }
      }
      if (DATA.length > 0) {
        var first = DATA[0];
        var firstChannel = first.channels[0];
        if (firstChannel) renderChannel(first.jobId, firstChannel.channel);
      }
    })();
  </script>
</body>
</html>
`;
}
