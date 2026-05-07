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

  /* ────── 6) UTM persistence (commit 3 expandirá esto a propagación a WhatsApp) ────── */
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

  /* ────── Debug log (remover en producción si molesta) ────── */
  if (window.console && window.console.log) {
    console.log('%c[Infinity Legacy Tracking v1.0]', 'color:#C7A76C;font-weight:bold', {
      project: currentProject || 'home',
      utms: window.IL_TRACKING.utms || null
    });
  }
})();
