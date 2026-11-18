/*
 * Service worker — la carte doit rester consultable sans réseau.
 *
 * Écrit à la main plutôt qu'avec Workbox : trois stratégies suffisent, et une
 * dépendance de build en moins vaut mieux qu'un fichier généré qu'on ne relit
 * jamais.
 *
 *   navigation   → réseau d'abord, puis la dernière page en cache
 *                  (au retour du réseau, on veut la version à jour)
 *   ressources   → cache d'abord (JS, CSS, polices, photos : noms figés)
 *   tuiles carte → cache d'abord, plafonné, pour que Palawan reste visible
 *                  dans l'avion
 *
 * Changer VERSION invalide tout : c'est le seul bouton à connaître.
 */

const VERSION = 'palawan-2026-v9';
const CACHE_APP = `${VERSION}-app`;
const CACHE_TUILES = `${VERSION}-tuiles`;

/** Au-delà, on jette les plus anciennes : ~40 Mo de tuiles, pas plus. */
const MAX_TUILES = 400;

const HOTES_TUILES = ['tiles.openfreemap.org'];

self.addEventListener('install', (e) => {
  // La page d'accueil est le seul fichier dont on connaisse le nom à l'avance ;
  // tout le reste porte un hachage et se met en cache à la première visite.
  e.waitUntil(
    caches.open(CACHE_APP).then((c) => c.addAll(['./', './index.html']).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const noms = await caches.keys();
      await Promise.all(noms.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Supprime les entrées les plus anciennes quand le cache déborde. */
async function plafonner(nomCache, max) {
  const cache = await caches.open(nomCache);
  const cles = await cache.keys();
  if (cles.length <= max) return;
  await Promise.all(cles.slice(0, cles.length - max).map((k) => cache.delete(k)));
}

async function cacheDAbord(req, nomCache, apresMiseEnCache) {
  const cache = await caches.open(nomCache);
  const connu = await cache.match(req);
  if (connu) return connu;
  const rep = await fetch(req);
  if (rep && rep.ok) {
    await cache.put(req, rep.clone());
    if (apresMiseEnCache) apresMiseEnCache();
  }
  return rep;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Navigation : réseau d'abord, cache en secours.
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const rep = await fetch(req);
          const cache = await caches.open(CACHE_APP);
          cache.put('./index.html', rep.clone());
          return rep;
        } catch {
          const cache = await caches.open(CACHE_APP);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response(
              '<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:2rem">Hors ligne, et cette page n’a pas encore été enregistrée. Reconnecte-toi une fois pour la garder.</p>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            )
          );
        }
      })(),
    );
    return;
  }

  // 2. Tuiles de carte : cache d'abord, plafonné.
  if (HOTES_TUILES.includes(url.hostname)) {
    e.respondWith(
      cacheDAbord(req, CACHE_TUILES, () => plafonner(CACHE_TUILES, MAX_TUILES)).catch(
        () => new Response('', { status: 504 }),
      ),
    );
    return;
  }

  // 3. Nos propres ressources : cache d'abord (leurs noms sont figés).
  if (url.origin === self.location.origin) {
    e.respondWith(cacheDAbord(req, CACHE_APP).catch(() => fetch(req)));
  }
});
