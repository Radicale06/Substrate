import fs from 'fs';
import { SNAPSHOT_POLL_INTERVAL_MS, SNAPSHOT_TEXT_CHANGE_DIVISOR } from '../config/constants';

const READABILITY_JS = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf-8');

/**
 * Injected into every frame. Bundles Mozilla Readability plus the DOM helpers that
 * `giveSnapshot()` needs, so a snapshot can be taken with a single `page.evaluate`.
 *
 * Child frames need these helpers because `snapshotChildFrames()` calls `giveSnapshot()`
 * in each of them on demand — but they must NOT run the reporter below.
 */
export const PAGE_HELPERS_SCRIPT = `
${READABILITY_JS}

function briefImgs(elem) {
    const imageTags = Array.from((elem || document).querySelectorAll('img[src],img[data-src]'));

    return imageTags.map((x)=> {
        let linkPreferredSrc = x.src;
        if (linkPreferredSrc.startsWith('data:')) {
            if (typeof x.dataset?.src === 'string' && !x.dataset.src.startsWith('data:')) {
                linkPreferredSrc = x.dataset.src;
            }
        }

        return {
            src: new URL(linkPreferredSrc, document.baseURI).toString(),
            loaded: x.complete,
            width: x.width,
            height: x.height,
            naturalWidth: x.naturalWidth,
            naturalHeight: x.naturalHeight,
            alt: x.alt || x.title,
        };
    });
}

function briefPDFs() {
    const pdfTags = Array.from(document.querySelectorAll('embed[type="application/pdf"]'));

    return pdfTags.map((x)=> {
        return x.src === 'about:blank' ? document.location.href : x.src;
    });
}

function getMaxDepthAndCountUsingTreeWalker(root) {
  let maxDepth = 0;
  let currentDepth = 0;
  let elementCount = 0;

  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    (node) => {
      const nodeName = node.nodeName.toLowerCase();
      return (nodeName === 'svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
    false
  );

  while (true) {
    maxDepth = Math.max(maxDepth, currentDepth);
    elementCount++;

    if (treeWalker.firstChild()) {
      currentDepth++;
    } else {
      while (!treeWalker.nextSibling() && currentDepth > 0) {
        treeWalker.parentNode();
        currentDepth--;
      }

      if (currentDepth <= 0) {
        break;
      }
    }
  }

  return {
    maxDepth: maxDepth + 1,
    elementCount: elementCount
  };
}

function giveSnapshot(stopActiveSnapshot) {
    if (stopActiveSnapshot) {
        window.haltSnapshot = true;
    }
    let parsed;
    try {
        parsed = new Readability(document.cloneNode(true)).parse();
    } catch (err) {
        void 0;
    }
    const domAnalysis = getMaxDepthAndCountUsingTreeWalker(document.documentElement);
    const r = {
        title: document.title,
        href: document.location.href,
        html: document.documentElement?.outerHTML,
        text: document.body?.innerText,
        parsed: parsed,
        imgs: [],
        pdfs: briefPDFs(),
        maxElemDepth: domAnalysis.maxDepth,
        elemCount: domAnalysis.elementCount,
    };
    if (document.baseURI !== r.href) {
        r.rebase = document.baseURI;
    }
    if (parsed && parsed.content) {
        const elem = document.createElement('div');
        elem.innerHTML = parsed.content;
        r.imgs = briefImgs(elem);
    } else {
        const allImgs = briefImgs();
        if (allImgs.length === 1) {
            r.imgs = allImgs;
        }
    }

    return r;
}
`;

/**
 * Polls the main frame and reports a fresh snapshot whenever the body text changes
 * materially, letting the server stream progressively better captures of a page that
 * is still loading. Requires `window.reportSnapshot` to be exposed from Node.
 *
 * Injected via `evaluateOnNewDocument`, so it lands in EVERY document — which is why the
 * top-frame check below is not optional. See the comment on it.
 */
export const SNAPSHOT_REPORTER_SCRIPT = `
if (window.top === window) {
    let lastTextLength = 0;
    const handlePageLoad = () => {
        if (window.haltSnapshot) {
            return;
        }
        const thisTextLength = (document.body.innerText || '').length;
        const deltaLength = Math.abs(thisTextLength - lastTextLength);
        if (${SNAPSHOT_TEXT_CHANGE_DIVISOR} * deltaLength < lastTextLength) {
            // Change is not significant
            return;
        }
        const r = giveSnapshot();
        window.reportSnapshot(r);
        lastTextLength = thisTextLength;
    };

    const timer = setInterval(handlePageLoad, ${SNAPSHOT_POLL_INTERVAL_MS});
    document.addEventListener('readystatechange', handlePageLoad);
    document.addEventListener('load', handlePageLoad);

    // Stop before this document's execution context goes away. A reportSnapshot call
    // that lands after its context is destroyed is the exact shape of the puppeteer
    // crash in <=22.8.0, and is wasted work even on a version that tolerates it.
    const stop = () => clearInterval(timer);
    window.addEventListener('pagehide', stop);
    window.addEventListener('beforeunload', stop);
}
`;
