# Radar Gasóleo

Dashboard simples para encontrar os combustíveis mais baratos em Portugal com
base nos dados públicos da DGEG e na geolocalização do navegador.

## Como abrir

Use um servidor local para que a geolocalização funcione corretamente:

```bash
cd "/Users/luisrita/Desktop/Fuel Prices"
python3 -m http.server 4173
```

Depois abra [http://localhost:4173](http://localhost:4173).

## Fonte de dados

- [DGEG Preços de Combustíveis](https://precoscombustiveis.dgeg.gov.pt/)
