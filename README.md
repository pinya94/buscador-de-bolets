# 🍄 Buscador de Bolets

App web sencilla para buscar zonas con probabilidad de setas en Cataluña.

**Abrir la app:** https://pinya94.github.io/buscador-de-bolets/

## Qué hace

Para cada punto del mapa combina:

- **Bosque** (Mapa de Cobertes del Sòl del ICGC, 2024): pinar, hayedo/robledal o encinar, denso o claro.
- **Orientación**: las obagas (laderas que miran al norte) puntúan más.
- **Pendiente**: las muy fuertes puntúan menos.
- **Altitud**: cada seta tiene su franja.
- **Lluvia** de los últimos 21 días y previsión (Open-Meteo), con un veredicto de si es buen momento.

Setas incluidas: rovelló, cep, camagroc, rossinyol, llenega negra y fredolic.

También puedes guardar "mis rincones" (se guardan en el propio móvil/navegador), ir a tu ubicación y abrir "Cómo llegar".

## Cómo se usa

1. Abre el enlace (mejor en el móvil).
2. Haz zoom en una zona boscosa (a partir de zoom 11 se calcula sola).
3. Elige la seta. Rojo intenso = zona más favorable.
4. Toca un punto para ver altitud, pendiente, orientación y tipo de bosque.

## Técnica

HTML + JS sin compilación (Leaflet). Todo se calcula en el navegador:

- Mapa base: ICGC (topográfico y ortofoto), OpenTopoMap.
- Relieve: AWS Terrain Tiles (formato terrarium).
- Bosques: WMS Cobertes del Sòl (ICGC), leído píxel a píxel.
- Tiempo: Open-Meteo.

Es orientativo. Nunca comas una seta sin identificarla al 100% y respeta la normativa de cada zona.
