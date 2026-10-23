# Distributed Wagering Processor — Jungle Gaming

Serviço financeiro distribuído de alta concorrência para processamento de transações de apostas (iGaming), desenvolvido com **Bun**, **NestJS**, **MikroORM**, **PostgreSQL** e **AWS SQS (LocalStack)**.

## 🚀 Visão Geral e Arquitetura

Este projeto foi desenhado para resolver problemas reais de sistemas distribuídos e transações financeiras críticas:
- **Correção Financeira Absoluta:** Uso de aritmética exata (`decimal.js` + colunas `NUMERIC(20, 2)` no PostgreSQL) e restrições rígidas no banco (`CHECK` constraints).
- **Concorrência em Hot Wallets:** Utilização de lock pessimista (`SELECT ... FOR UPDATE`) na carteira para serializar acessos simultâneos sem corromper saldos ou causar *lost updates*.
- **Idempotência Persistente:** Controle rigoroso via restrição `UNIQUE` em chaves de idempotência e hash canônico de payload (`SHA-256`).
- **Transactional Outbox & Inbox:** Publicação assíncrona segura e atômica de eventos de integração e deduplicação de mensagens de filas.
- **Resiliência e Recuperação:** Tratamento de referências fora de ordem (`PENDING_REFERENCE`) com retries e backoff exponencial, além de Dead Letter Queue (DLQ).

---

## 🛠️ Stack Tecnológica

- **Runtime & Package Manager:** Bun 1.x
- **Framework:** NestJS 10.x
- **ORM & Migrations:** MikroORM (PostgreSQL)
- **Mensageria:** AWS SQS (via LocalStack)
- **Orquestração:** Docker Compose

---

## ⚙️ Como Executar o Projeto Localmente

### Pré-requisitos
- [Bun](https://bun.sh/) instalado na máquina.
- [Docker e Docker Compose](https://www.docker.com/) rodando.

### 1. Instalar Dependências
Na pasta raiz do projeto, execute:
```bash
bun install