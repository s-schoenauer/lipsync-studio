# Lipsync Studio

Webapp für perfekt synchrone Lipsync-Videos zu eigenen Songs – auch mit AirPods.

**Prinzip:** Die App spielt den Song nur ab und nimmt ausschließlich Video auf (kein Mikrofon). Beim Export wird der Original-Song digital eingebettet und um die gemessene Kopfhörer-Latenz verschoben. Ergebnis: 1080×1920 MP4 (H.264 + AAC) für TikTok.

## Ablauf

1. Song laden (MP3/WAV/M4A) und Ausschnitt wählen
2. Einmal pro Kopfhörer den Versatz messen (im Takt tippen)
3. Aufnehmen – Countdown, dann läuft der Song
4. Vorschau prüfen, bei Bedarf feinjustieren (±10 ms, ±1 Frame)
5. Exportieren → Teilen / In Fotos sichern

Alles läuft lokal im Browser, nichts wird hochgeladen.

## Hosting

Statische Dateien, kein Build-Schritt. Läuft auf GitHub Pages (Settings → Pages → Branch `main`, Ordner `/`). HTTPS ist Pflicht für Kamerazugriff.

Auf dem iPhone: Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

## Technik

- Web Audio API (geplante Wiedergabe, Klicks, Kalibrierung)
- MediaRecorder (nur Video)
- [Mediabunny](https://mediabunny.dev) für Decoding, Vorschau und MP4-Export (MPL-2.0), plus `@mediabunny/aac-encoder` als Fallback für Browser ohne AAC-Encoder
