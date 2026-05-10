# CampoSat

Aplicacao web para monitoramento operacional de fazendas e talhoes por agronomo, com foco em leitura NDVI, historico de alertas e acompanhamento de carteira.

## Estado atual

O projeto hoje funciona como um MVP local com:

- login e cadastro de agronomo
- carteira isolada por usuario
- painel com talhoes do agronomo logado
- detalhe de talhao com mapa ilustrado e historico visual
- analise individual e em lote
- historico de alertas
- backend local em Python com persistencia em SQLite
- fallback offline no frontend quando a API nao estiver disponivel

## Stack

- `HTML`
- `CSS`
- `JavaScript`
- `Python`

## Estrutura

- [index.html](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/index.html)
- [app.js](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/app.js)
- [styles.css](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/styles.css)
- [server.py](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/server.py)
- [data/seed_state.json](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/data/seed_state.json)
- `data/camposat.db` (gerado em runtime)

## Como rodar

No PowerShell:

```powershell
cd "C:\Users\guica\.gemini\antigravity\scratch\Agro-main\Agro-main"
python server.py --port 8000
```

Depois abra:

- [http://127.0.0.1:8000](http://127.0.0.1:8000)

## Contas demo

- `marina@camposat.demo`
- `rafael@camposat.demo`
- `bianca@camposat.demo`
- `ana@camposat.demo`

Senha demo:

- `camposat123`

## Rotas principais da API

- `GET /api/health`
- `GET /api/auth/session`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `GET /api/bootstrap`
- `POST /api/plots`
- `POST /api/analyze`
- `POST /api/analyze-batch`
- `POST /api/reset`

## O que ainda e mockado

- imagens de satelite reais
- NDVI real por poligono
- mapa geoespacial real
- clima real por API externa
- envio real de WhatsApp
- banco relacional de producao

## Proximos passos

1. migrar persistencia de arquivos para `SQLite` ou `PostgreSQL`
2. adicionar mapa real com geometria de talhao
3. integrar imagens de satelite e NDVI real
4. conectar clima real
5. integrar envio de alerta por WhatsApp
6. mover sessoes de memoria para persistencia mais robusta

## Observacao

O arquivo `data/state.json` representa estado local de execucao. O conjunto base de dados do projeto parte de `data/seed_state.json`.
