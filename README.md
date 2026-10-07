# Pulso Hídrico · Santa Marta

V1 estática y preparada para GitHub Pages. La interfaz visualiza ríos de Santa Marta, lluvia observada/pronosticada y una ventana preliminar de respuesta hidrológica.

## Qué contiene esta V1

- Dashboard visual de alta densidad.
- Mapa Leaflet con Manzanares, Gaira y Guachaca.
- Estaciones representativas y capas de río.
- Pronóstico de precipitación con Open-Meteo.
- Adaptador experimental para datasets abiertos de IDEAM en datos.gov.co:
  - Caudales medios diarios: `jxnq-r3i9`
  - Caudales horarios: `79gx-f3v5`
  - Catálogo de estaciones: `hp9r-jxuu`
- Distinción visible entre datos reales, demo y modelo preliminar.
- Gráfico combinado de caudal/lluvia.
- Modelo inicial de ventana de respuesta lluvia → caudal.

## Ejecutar

No necesita Node para esta V1.

Abre `index.html` en un navegador moderno. Como usa servicios CDN, necesitas conexión a Internet.

## Publicar en GitHub Pages

1. Crea un repositorio, por ejemplo `pulso-hidrico-santa-marta`.
2. Sube `index.html`, `styles.css`, `app.js` y la carpeta `.github`.
3. En GitHub: Settings → Pages → GitHub Actions.
4. El workflow de `.github/workflows/pages.yml` publica automáticamente la raíz del proyecto.

## Datos y fuentes

IDEAM mantiene datasets abiertos de caudales medios diarios y horarios en datos.gov.co y un Catálogo Nacional de Estaciones. La página institucional de datos abiertos muestra actualmente esos datasets con publicación en agosto de 2026.

La capa de precipitación y pronóstico del prototipo usa Open-Meteo. Para producción se recomienda integrar también observación y pronóstico oficiales del IDEAM y, posteriormente, un proceso backend que calibre el tiempo de respuesta de cada cuenca.

## Importante

La frase “debería aumentar el caudal en X horas” es, en esta V1, un **modelo preliminar**. No es una alerta hidrológica oficial. En la siguiente etapa debemos calcular ese rezago con series históricas de precipitación y caudal por cuenca y estación.
