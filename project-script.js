// Hero slider
(function(){
  const slides = document.querySelectorAll('.hs-slide');
  const dotsWrap = document.getElementById('hsDots');
  const prev = document.getElementById('hsPrev');
  const next = document.getElementById('hsNext');
  if(!slides.length) return;
  let cur = 0, timer;
  const dots = [];

  slides.forEach((_,i)=>{
    const d = document.createElement('button');
    d.className = 'hs-dot' + (i===0?' on':'');
    d.addEventListener('click',()=>{ go(i); reset(); });
    dotsWrap.appendChild(d);
    dots.push(d);
  });

  function go(n){
    slides[cur].classList.remove('on');
    dots[cur].classList.remove('on');
    cur = ((n%slides.length)+slides.length)%slides.length;
    slides[cur].classList.add('on');
    dots[cur].classList.add('on');
  }
  slides[0].classList.add('on');
  function reset(){ clearInterval(timer); timer = setInterval(()=>go(cur+1),4500); }
  if(prev) prev.addEventListener('click',()=>{ go(cur-1); reset(); });
  if(next) next.addEventListener('click',()=>{ go(cur+1); reset(); });
  reset();
})();

// Scroll reveal
(function(){
  const obs = new IntersectionObserver(entries=>{
    entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('on'); obs.unobserve(e.target); } });
  },{threshold:.1,rootMargin:'0px 0px -50px 0px'});
  document.querySelectorAll('.r,.rl,.rr').forEach(el=>obs.observe(el));
})();

// Nav scroll
(function(){
  const nav = document.getElementById('nav');
  if(!nav) return;
  window.addEventListener('scroll',()=>nav.classList.toggle('scrolled',scrollY>60),{passive:true});
})();

// Gallery lightbox
(function(){
  const items = document.querySelectorAll('.gal-item');
  if(!items.length) return;
  const imgs = Array.from(items).map(i=>i.querySelector('img')?.src).filter(Boolean);

  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<button class="lb-close">✕</button><button class="lb-prev">&#8592;</button><img class="lb-img" /><button class="lb-next">&#8594;</button>`;
  document.body.appendChild(lb);

  const lbImg = lb.querySelector('.lb-img');
  let lbCur = 0;
  const lbGo = n=>{ lbCur=((n%imgs.length)+imgs.length)%imgs.length; lbImg.src=imgs[lbCur]; };

  items.forEach((item,i)=>item.addEventListener('click',()=>{ lbGo(i); lb.classList.add('on'); }));
  lb.querySelector('.lb-close').addEventListener('click',()=>lb.classList.remove('on'));
  lb.querySelector('.lb-prev').addEventListener('click',()=>lbGo(lbCur-1));
  lb.querySelector('.lb-next').addEventListener('click',()=>lbGo(lbCur+1));
  lb.addEventListener('click',e=>{ if(e.target===lb) lb.classList.remove('on'); });
  document.addEventListener('keydown',e=>{ if(!lb.classList.contains('on')) return; if(e.key==='Escape') lb.classList.remove('on'); if(e.key==='ArrowLeft') lbGo(lbCur-1); if(e.key==='ArrowRight') lbGo(lbCur+1); });
})();

// Smooth scroll
document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{ const t=document.querySelector(a.getAttribute('href')); if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'});} });
});
