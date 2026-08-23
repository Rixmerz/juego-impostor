# 🕵️ Juego del Impostor

Party game para jugar en persona, cada uno desde su celular, conectados a la misma WiFi.
Todos reciben la misma palabra secreta… menos el impostor.

<p align="center">
  <b>Crear sala → compartir código → repartir cartas → debatir → votar</b>
</p>

---

## Cómo levantarlo y exponerlo por WiFi

```bash
npm install
npm start
```

> Solo se instalan 3 dependencias (~32 MB). Playwright **no** viene incluido:
> hace falta únicamente para el test e2e y se instala aparte (ver *Pruebas*).

La consola imprime la dirección local, **la dirección de tu WiFi** y un **código QR**:

```
  🕵️  JUEGO DEL IMPOSTOR
  ─────────────────────────────────────────
  Local:   http://localhost:3000
  WiFi:    http://192.168.1.42:3000   (wlan0)
  ─────────────────────────────────────────
  Escanea este QR desde el celular:

  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █▄▀▀▄▄▄▀█ ▄▄▄▄▄ █
  ...
```

El servidor escucha en `0.0.0.0`, así que **cualquier celular en la misma red** entra
con esa dirección `http://192.168.x.x:3000`. Escanea el QR o pásale el link al resto.

### Variables

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor (`PORT=8080 npm start`) |
| `HOST` | `0.0.0.0` | Interfaz donde escucha. `127.0.0.1` lo deja solo local |
| `NO_QR` | – | `NO_QR=1` no imprime el código QR |
| `PUBLIC_URL` | – | URL pública a mostrar y codificar en el QR, en vez de la IP local. En Render se toma sola de `RENDER_EXTERNAL_URL` |

Ninguna es obligatoria: `npm start` a secas funciona.

### Si los celulares no se conectan

- Todos deben estar en **la misma red** (ojo con las redes "Invitados", que aíslan dispositivos).
- El firewall del computador tiene que permitir el puerto 3000.
- Usa la IP que imprime la consola, no `localhost` (en el celular `localhost` es el celular).

### Levantarlo desde un celular Android (sin computador)

Con [Termux](https://f-droid.org/packages/com.termux/) (**instálalo desde F-Droid**, la versión
de Play Store está abandonada y falla):

```bash
pkg update && pkg install nodejs git
git clone https://github.com/Rixmerz/juego-impostor
cd juego-impostor
npm install
npm start
```

Las dependencias son JavaScript puro, así que no hay nada que compilar y funciona en ARM.
Termux imprime la IP igual que en un computador; el resto se conecta a esa dirección.
Si no hay WiFi, activa el **hotspot** del teléfono que hace de servidor y que los demás
se conecten ahí: la IP que imprime sigue siendo válida dentro de esa red.

Mantén Termux abierto — si Android lo mata en segundo plano, se cae la partida.
`termux-wake-lock` antes de `npm start` ayuda.

En **iPhone no hay una opción razonable**: iOS no permite correr Node de verdad. Usa un
computador, un Android, o súbelo a un hosting gratuito (Render, Railway, Fly.io) y jueguen
desde cualquier red.

### Subirlo a Render (jugar sin estar en la misma red)

El repo trae `render.yaml`, así que no hay nada que configurar a mano:

1. En [Render](https://dashboard.render.com): **New → Blueprint**.
2. Conecta este repositorio. Render lee `render.yaml` y arma el servicio solo.
3. **Apply**. Al terminar entrega una URL tipo `https://juego-impostor.onrender.com`.

Eso es todo: esa URL la abre cualquiera desde cualquier red, sin IPs ni QR.

**Variables de entorno: ninguna.** Render inyecta `PORT` y `RENDER_EXTERNAL_URL`
automáticamente, y el servidor las usa tal cual (`RENDER_EXTERNAL_URL` es lo que hace
que el QR y el log apunten a la URL pública en vez de a una IP interna del contenedor).
Lo único que fija el blueprint es `NODE_VERSION=22`.

Si prefieres crear el servicio a mano en vez de usar el blueprint:

| Campo | Valor |
|---|---|
| Runtime | Node |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check path | `/api/health` |

#### Lo que tienes que saber del plan gratis

- **Se apaga tras ~15 minutos sin visitas** y la primera carga después tarda ~50 s.
  Las salas viven en memoria, así que **al apagarse se pierden**. Para una partida
  seguida no molesta; si vas a jugar más tarde, abre la URL un minuto antes.
- **Una sola instancia.** Es lo correcto aquí: al vivir el estado en memoria, escalar a
  varias instancias partiría las salas entre ellas. Si algún día lo escalas, Socket.IO
  necesita sticky sessions y un adapter compartido.
- WebSockets funcionan sin configuración extra.

---

## Cómo se juega

1. **Inicio** — cada uno escribe su nombre. Uno crea la sala, el resto se une con el código de 4 letras
   o abriendo el link directo (`.../?sala=ABCD`), que el anfitrión comparte tocando el código.
   Quien llega con una partida en curso entra igual y juega desde la ronda siguiente.
2. **Configuración** (solo el anfitrión) — jugadores, impostores, pista, tópico visible, tiempo y tópicos.
3. **Cartas** — cada jugador **mantiene presionada** su carta para verla en privado.
   - Tripulantes: ven la palabra.
   - Impostores: ven que lo son, y la pista si está activada.
4. **Debate** — se muestra el tópico, el orden para hablar y un cronómetro.
   Cada uno dice **una sola palabra** relacionada: ni tan obvia que delate la palabra,
   ni tan vaga que te haga parecer el impostor.
5. **Votación** — todos votan (o saltan). Se puede cerrar antes desde el anfitrión.
6. **Resultados** — se revela la palabra, quiénes eran impostores y el marcador.

### Puntaje

| Situación | Puntos |
|---|---|
| Eliminan a un impostor | +1 a cada tripulante |
| Eliminan a un inocente | +2 a cada impostor |
| Empate en la votación | +2 a cada impostor (nadie sale) |

---

## Configuración de la partida

| Opción | Rango | Detalle |
|---|---|---|
| **Jugadores** | 3 – 20 | Cupos de la sala |
| **Impostores** | 1 – ⌊(jugadores−1)/2⌋ | El tope se ajusta solo según cuántos haya conectados |
| **Pista para el impostor** | sí / no | Le da una pista vaga sobre la palabra (ej: palabra *Titanic* → pista *"Un barco y un desastre"*) |
| **Mostrar el tópico** | sí / no | Si está activo, al iniciar la partida todos ven de qué categoría es la palabra |
| **Tiempo de debate** | 0 – 15 min | En 0 no hay cronómetro y avanzan cuando quieran |
| **Tópicos** | 1 – 12 categorías | Se eligen tocando los chips |

### Tópicos incluidos

🎬 Películas · 🐾 Animales · 🍥 Anime · 🍕 Comida · ⚽ Deportes · 🌍 Países y Lugares
👩‍⚕️ Profesiones · 🏠 Objetos de casa · 🎮 Videojuegos · 📺 Series de TV · 🎵 Música y Artistas · 🦸 Superhéroes

**360 palabras**, cada una con su pista. Para agregar más, edita `server/words.js`:

```js
{
  id: 'mi-categoria',
  name: 'Mi Categoría',
  emoji: '🎯',
  words: [
    'Palabra|pista vaga para el impostor',
    // ...
  ]
}
```

---

## Detalles de la implementación

- **Sin build**: HTML, CSS y JS a secas. Se abre y funciona.
- **Móvil primero**: targets de 52 px, `safe-area` para el notch, alto fijo al viewport
  (el contenido scrollea dentro, los botones nunca se van de pantalla), soporte de vibración
  y `prefers-reduced-motion`.
- **Conexión que aguanta**: arranca por HTTP polling y sube a WebSocket solo cuando la red lo
  permite, así funciona también donde el WebSocket está bloqueado (WiFi corporativo, colegios,
  algunas operadoras, VPNs).
- **Reconexión**: la sesión queda guardada en `localStorage`; si se cierra el navegador, se
  bloquea la pantalla o se pasa de WiFi a datos, al volver recupera la sala y su carta. En el
  lobby hay 45 s de gracia antes de sacar a nadie, y si alguien se cae a mitad de ronda, la
  partida sigue en vez de quedarse esperándolo.
- **La palabra nunca viaja de más**: el estado público que reciben todos no incluye la palabra,
  la pista ni quiénes son impostores. Cada jugador recibe su carta por un canal privado
  (hay pruebas que lo verifican).
- **Instalable**: incluye manifest, así que se puede "Agregar a la pantalla de inicio".

```
server/
  index.js    servidor HTTP + Socket.IO + descubrimiento de IP y QR
  game.js     salas, rondas, roles, votación y puntaje
  words.js    banco de palabras con pistas
public/
  index.html  todas las pantallas
  css/        estilos móviles
  js/app.js   cliente
test/
  game.test.js  31 pruebas (lógica + sockets)
  e2e.js        partida completa con 5 navegadores reales
```

---

## Pruebas

```bash
npm test              # lógica del juego + partida por sockets (no necesita navegador)
npm run test:e2e      # partida completa con 5 celulares simulados
npm run test:sesiones # transporte, link directo, entrar a mitad de partida y reconexión
npm run test:all      # todo lo anterior
```

Los dos últimos necesitan el servidor corriendo.

Para el e2e hace falta Playwright:

```bash
npm i -D playwright && npx playwright install chromium
npm start                       # en otra terminal
npm run test:e2e                # SMALL=1 para probar en pantalla chica
SHOTS=./capturas npm run test:e2e   # guarda capturas de cada pantalla
```
