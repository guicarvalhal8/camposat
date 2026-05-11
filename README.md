# CampoSat

Aplicacao web para monitoramento operacional de fazendas e talhoes por agronomo, com foco em leitura NDVI, historico de alertas e acompanhamento de carteira.

## Estado atual

O projeto hoje funciona como um MVP local com:

- login e cadastro de agronomo
- carteira isolada por usuario
- painel com talhoes do agronomo logado
- detalhe de talhao com mapa real, poligono georreferenciado e hotspot
- analise individual e em lote
- historico de alertas
- backend local em Python com persistencia em SQLite
- modelagem relacional inicial entre agronomo, fazenda e talhao
- fallback offline no frontend quando a API nao estiver disponivel

## Stack

- `HTML`
- `CSS`
- `JavaScript`
- `Python`
- `MapLibre GL JS`

## Estrutura

- [index.html](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/index.html)
- [app.js](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/app.js)
- [styles.css](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/styles.css)
- [server.py](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/server.py)
- [data/seed_state.json](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/data/seed_state.json)
- `data/camposat.db` (gerado em runtime com usuarios, fazendas, talhoes e alertas)

## Ativar Sentinel Hub

Para ligar imagem real e NDVI real por talhao:

1. crie o arquivo `.env.local` na raiz do projeto usando [`.env.local.example`](C:/Users/guica/.gemini/antigravity/scratch/Agro-main/Agro-main/.env.local.example) como base
2. preencha:
   - `SENTINELHUB_CLIENT_ID`
   - `SENTINELHUB_CLIENT_SECRET`
3. reinicie o servidor

Exemplo no PowerShell:

```powershell
cd "C:\Users\guica\.gemini\antigravity\scratch\Agro-main\Agro-main"
copy .env.local.example .env.local
notepad .env.local
python server.py --port 8000
```

Quando essas credenciais estiverem validas, o app passa a tentar:

- buscar foto real da cena
- buscar NDVI visual da mesma cena
- calcular NDVI medio real do talhao

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

- geometrias reais dos talhoes
- NDVI real por poligono
- imagens de satelite reais
- clima real por API externa
- envio real de WhatsApp
- banco relacional de producao

## Proximos passos

1. mover sessoes de memoria para persistencia mais robusta
2. integrar geometria real de talhao vinda de cadastro ou GeoJSON
3. consolidar o NDVI real do talhao com mais estatisticas e historico temporal
4. conectar clima real
5. integrar envio de alerta por WhatsApp
6. evoluir de `SQLite` para `PostgreSQL` com PostGIS

## Observacao

O arquivo `data/state.json` representa estado local de execucao. O conjunto base de dados do projeto parte de `data/seed_state.json`.
