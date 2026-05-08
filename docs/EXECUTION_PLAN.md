# CampoSat - Plano de Execucao

## Objetivo
Transformar o prototipo atual em um aplicativo funcional de monitoramento agricola com:

- mapa detalhado por talhao
- historico de NDVI
- estrutura para imagens de satelite
- clima por localizacao
- precos de soja e milho
- alertas operacionais e envio futuro por WhatsApp

## Ordem de prioridade

### 1. Base funcional do produto
- API local para servir dados do app
- persistencia em arquivo
- modelo de dados de talhao, cena, alerta, clima e mercado
- frontend consumindo API em vez de depender apenas de estado em memoria

### 2. Mapa detalhado
- detalhe do talhao com visualizacao mais rica
- alternancia de camadas
- historico de cenas
- metadados de leitura: data, nuvem, origem, resolucao

### 3. Operacao do monitoramento
- filtros por status, cultura e busca
- analise individual e em lote
- historico de alertas
- cadastro de talhao

### 4. Estrutura de integracoes reais
- provider de satelite
- provider de clima
- provider de mercado
- provider de WhatsApp

## Escopo desta iteracao

### Executar agora
- criar backend local em Python
- persistir estado em `data/state.json`
- criar endpoints para bootstrap, cadastro, analise, analise em lote, alertas e reset
- criar providers com fallback local para:
  - satelite
  - clima
  - mercado
  - WhatsApp
- reescrever frontend para consumir a API
- fortalecer a tela de detalhe do mapa

### Fica preparado, mas ainda mockado
- imagem real do Sentinel-2
- clima vindo de API externa
- cotacao real de soja e milho
- envio real de WhatsApp

## Proxima iteracao sugerida
1. integrar Sentinel Hub / Copernicus
2. integrar Open-Meteo ou INMET
3. integrar Twilio WhatsApp
4. adicionar cache de imagens e recortes por talhao
