// Smooth scroll for in-page anchors
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute('href').slice(1);
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Simple intersection observer to animate steps
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  }
}, { threshold: 0.2 });

document.querySelectorAll('.step').forEach((el) => observer.observe(el));

// Accordion behavior for indexing details
document.querySelectorAll('.acc-header').forEach((btn) => {
  btn.addEventListener('click', () => {
    const item = btn.parentElement;
    const open = item.classList.contains('open');
    document.querySelectorAll('.acc-item.open').forEach((other) => other.classList.remove('open'));
    if (!open) item.classList.add('open');
  });
});

// Syntax highlighting for static code blocks
if (window.hljs) {
  window.addEventListener('load', () => window.hljs.highlightAll());
}


