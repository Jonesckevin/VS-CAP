// Init Mermaid with theme matching current page theme
function initMermaid() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    themeVariables: isDark ? {
      primaryColor: '#264f78',
      primaryTextColor: '#d4d4d4',
      primaryBorderColor: '#3e3e42',
      lineColor: '#569cd6',
      secondaryColor: '#1a3a2a',
      tertiaryColor: '#2d2d2d',
      fontFamily: '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      fontSize: '13px'
    } : {
      fontFamily: '-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      fontSize: '13px'
    },
    flowchart: { curve: 'basis', padding: 16, htmlLabels: true }
  });
  mermaid.run({ querySelector: 'pre.mermaid' });
}

if (typeof mermaid !== 'undefined') {
  // Store original Mermaid source for theme re-renders
  document.querySelectorAll('pre.mermaid').forEach(el => {
    el.setAttribute('data-original', el.innerHTML);
  });
  initMermaid();
} else {
  // Fallback: show raw text if Mermaid fails to load
  document.querySelectorAll('pre.mermaid').forEach(el => {
    el.style.fontFamily = 'var(--font-mono)';
    el.style.whiteSpace = 'pre';
    el.style.textAlign = 'left';
  });
}

// Nav active state
const navLinks = document.querySelectorAll('nav a');
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(l => l.classList.remove('active'));
      const link = document.querySelector(`nav a[href="#${entry.target.id}"]`);
      if (link) link.classList.add('active');
    }
  });
}, { rootMargin: '-20% 0px -70% 0px' });

document.querySelectorAll('h1[id], h2[id]').forEach(el => observer.observe(el));

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  document.querySelector('.theme-toggle').textContent = next === 'dark' ? '🌙 Theme' : '☀️ Theme';
  // Re-render Mermaid diagrams with new theme
  if (typeof mermaid !== 'undefined') {
    document.querySelectorAll('pre.mermaid').forEach(el => {
      el.removeAttribute('data-processed');
      el.innerHTML = el.getAttribute('data-original') || el.innerHTML;
    });
    initMermaid();
  }
}
