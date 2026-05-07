/*
 * Infinity Legacy — Tracking System v1.0
 * Pixel ID: 847380765079387
 *
 * Sistema unificado de tracking que dispara eventos a:
 *   - Meta Pixel (fbq)
 *   - window.dataLayer (para futuro GTM / GA4)
 *
 * Cubre:
 *   1) ViewContent automático en páginas de proyecto
 *   2) Lead tracking en clicks de WhatsApp
 *   3) Lead tracking en envío de formulario de contacto
 *   4) Scroll depth (25%, 50%, 75%, 90%)
 *   5) Time on page (15s, 30s, 60s, 120s)
 *   6) UTM persistence en sessionStorage
 *
 * Mantenido por: Claude + Iván Cadavieco
 */
(function () {
  'use strict';

  /* ────── Init dataLayer para futuro GTM ────── */
  window.dataLayer = window.dataLayer || [];

  /* ────── Mapeo slug → nombre humano de proyecto ────── */
  var PROJECTS = {
    'monte-vinum':    'Monte Vinum',
    'azizi-venice':   'Azizi Venice',
    'citrus-limones': 'Citrus Limones',
    'hospital':       'Hospital Real de Angeles',
    'kukulkan':       'Jungle Kukulkan',
    'luxury-clinics': 'Luxury Clinics',
    'town-houses':    'Town Houses Puerto Angel'
  };

  /* ────── Detectar proyecto actual de la URL ────── */
  var currentProject = null;
  var path = window.location.pathname.toLowerCase();
  for (var slug in PROJECTS) {
    if (path.indexOf(slug) !== -1) {
      currentProject = PROJECTS[slug];
      break;
    }
  }

  /* ────── Helper unificado: dispara fbq + dataLayer ────── */
  var STANDARD_EVENTS = ['ViewContent', 'Lead', 'InitiateCheckout', 'Contact', 'Purchase', 'CompleteRegistration', 'Search'];
  function track(eventName, params) {
    params = params || {};
    if (typeof window.fbq === 'function') {
      if (STANDARD_EVENTS.indexOf(eventName) !== -1) {
        window.fbq('track', eventName, params);
      } else {
        window.fbq('trackCustom', eventName, params);
      }
    }
    window.dataLayer.push(Object.assign({ event: eventName }, params));
  }

  /* Expose for debugging in DevTools */
  window.IL_TRACKING = {
    currentProject: currentProject,
    track: track,
    version: '1.0.0'
  };

  /* ────── 1) ViewContent en páginas de proyecto ────── */
  if (currentProject) {
    track('ViewContent', {
      content_name:     currentProject,
      content_category: 'Real Estate Investment',
      content_type:     'product',
      content_ids:      [currentProject.toLowerCase().replace(/\s+/g, '-')]
    });
  }

  /* ────── 2) WhatsApp click tracking (Lead event) ────── */
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="whatsapp://"]');
    if (link) {
      track('Lead', {
        content_name:     'WhatsApp - ' + (currentProject || 'Home'),
        content_category: 'WhatsApp Click',
        source:           currentProject || 'home',
        value:            0,
        currency:         'MXN'
      });
    }
  }, true);

  /* ────── 3) Form submit tracking (Lead event de mayor intención) ────── */
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.tagName === 'FORM') {
      track('Lead', {
        content_name:     'Contact Form - ' + (currentProject || 'Home'),
        content_category: 'Contact Form',
        source:           currentProject || 'home',
        value:            0,
        currency:         'MXN'
      });
    }
  }, true);

  /* ────── 4) Scroll depth tracking ────── */
  var scrollMilestones = [25, 50, 75, 90];
  var firedScroll = {};
  function checkScroll() {
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return;
    var pct = Math.round((window.scrollY / docHeight) * 100);
    for (var i = 0; i < scrollMilestones.length; i++) {
      var m = scrollMilestones[i];
      if (pct >= m && !firedScroll[m]) {
        firedScroll[m] = true;
        track('ScrollDepth' + m, {
          percent: m,
          page:    currentProject || 'home'
        });
      }
    }
  }
  var scrollTimer;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      checkScroll();
      scrollTimer = null;
    }, 250);
  }, { passive: true });

  /* ────── 5) Time on page milestones ────── */
  var timeMilestones = [15, 30, 60, 120];
  timeMilestones.forEach(function (sec) {
    setTimeout(function () {
      track('TimeOnPage' + sec + 's', {
        seconds: sec,
        page:    currentProject || 'home'
      });
    }, sec * 1000);
  });

  /* ────── 6) UTM persistence ────── */
  try {
    var params = new URLSearchParams(window.location.search);
    var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];
    var utms = {};
    utmKeys.forEach(function (k) {
      if (params.has(k)) utms[k] = params.get(k);
    });
    if (Object.keys(utms).length > 0) {
      utms._captured_at = new Date().toISOString();
      utms._landing_page = window.location.pathname;
      sessionStorage.setItem('IL_UTMS', JSON.stringify(utms));
      window.IL_TRACKING.utms = utms;
      track('UTMCapture', utms);
    } else {
      var stored = sessionStorage.getItem('IL_UTMS');
      if (stored) window.IL_TRACKING.utms = JSON.parse(stored);
    }
  } catch (e) { /* sessionStorage may be blocked */ }

  /* ────── 7) UTM propagation to WhatsApp links (closed-loop attribution) ──────
   * Cuando el visitante llega con UTMs (= viene de un anuncio), reescribimos
   * TODOS los links de WhatsApp del sitio para que el mensaje pre-llenado
   * incluya un marcador [il-ref: ...] con el origen exacto.
   *
   * Resultado: el agente que recibe el WA sabe qué anuncio cerró el lead.
   * Esto es LO QUE NADIE HACE BIEN en LATAM y nos da atribución end-to-end.
   */
  function buildRefString() {
    var u = window.IL_TRACKING.utms;
    if (!u) return null;
    var parts = [];
    if (u.utm_source)   parts.push('src=' + u.utm_source);
    if (u.utm_medium)   parts.push('med=' + u.utm_medium);
    if (u.utm_campaign) parts.push('cmp=' + u.utm_campaign);
    if (u.utm_content)  parts.push('cnt=' + u.utm_content);
    if (u.utm_term)     parts.push('trm=' + u.utm_term);
    if (u.fbclid)       parts.push('fbc=' + u.fbclid.substring(0, 24));
    if (u.gclid)        parts.push('gcl=' + u.gclid.substring(0, 24));
    if (u.ttclid)       parts.push('ttc=' + u.ttclid.substring(0, 24));
    if (currentProject) parts.push('pg=' + currentProject.toLowerCase().replace(/\s+/g, '-'));
    if (parts.length === 0) return null;
    return '[il-ref: ' + parts.join(' ') + ']';
  }

  function rewriteWhatsAppLinks() {
    var ref = buildRefString();
    if (!ref) return; // No hay UTMs → no reescribimos (visita orgánica)

    var selectors = [
      'a[href*="wa.me"]',
      'a[href*="api.whatsapp.com"]',
      'a[href*="whatsapp://"]'
    ].join(', ');

    var links = document.querySelectorAll(selectors);
    var rewritten = 0;
    links.forEach(function (link) {
      try {
        var href = link.getAttribute('href');
        if (!href || href.indexOf('[il-ref:') !== -1) return; // ya tiene ref

        // wa.me/<num>?text=... | api.whatsapp.com/send?phone=<num>&text=...
        var url;
        if (href.indexOf('whatsapp://') === 0) {
          // Custom scheme — parsear manual
          var match = href.match(/text=([^&]*)/);
          var existingText = match ? decodeURIComponent(match[1]) : '';
          var newText = existingText ? existingText + '\n\n' + ref : ref;
          var newHref = match
            ? href.replace(/text=[^&]*/, 'text=' + encodeURIComponent(newText))
            : href + (href.indexOf('?') === -1 ? '?' : '&') + 'text=' + encodeURIComponent(newText);
          link.setAttribute('href', newHref);
        } else {
          // wa.me / api.whatsapp.com — usar URL parser
          url = new URL(href, window.location.origin);
          var existingText = url.searchParams.get('text') || '';
          var newText = existingText ? existingText + '\n\n' + ref : ref;
          url.searchParams.set('text', newText);
          link.setAttribute('href', url.toString());
        }
        rewritten++;
      } catch (e) { /* malformed URL — skip */ }
    });

    if (rewritten > 0) {
      track('WhatsAppLinksRewritten', {
        count: rewritten,
        ref: ref
      });
    }
  }

  // Ejecutar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteWhatsAppLinks);
  } else {
    rewriteWhatsAppLinks();
  }

  // Re-ejecutar si se agregan links dinámicamente (SPAs, lazy load, etc.)
  if (window.MutationObserver) {
    var observer = new MutationObserver(function (mutations) {
      var hasNewLinks = mutations.some(function (m) {
        return Array.from(m.addedNodes).some(function (n) {
          return n.nodeType === 1 && (
            (n.matches && n.matches('a[href*="wa.me"], a[href*="api.whatsapp.com"]')) ||
            (n.querySelectorAll && n.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"]').length > 0)
          );
        });
      });
      if (hasNewLinks) rewriteWhatsAppLinks();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  // Expose for manual re-trigger / debugging
  window.IL_TRACKING.rewriteWhatsApp = rewriteWhatsAppLinks;
  window.IL_TRACKING.buildRef = buildRefString;

  /* ────── Debug log (remover en producción si molesta) ────── */
  if (window.console && window.console.log) {
    console.log('%c[Infinity Legacy Tracking v1.0]', 'color:#C7A76C;font-weight:bold', {
      project: currentProject || 'home',
      utms: window.IL_TRACKING.utms || null
    });
  }
})();
