# Enrichment Desk

Lead enrichment and decision-maker discovery system for a cold-calling operation
selling an AI receptionist to local service businesses.

**The central question:** how many dials does it take to have a conversation with
someone who can buy? This system exists to raise decision-maker conversations per
100 dials while keeping enrichment costs low. It does NOT assume an owner's
private cell is required — the main business line plus knowing *who to ask for*
is usually enough.

## Repository structure

```
enrichment/
├── docker-compose.yml          # postgres + backend + frontend
├── .env.example
├── sample_data/
│   ├── import_template.csv     # canonical column names
│   └── leads_sample.csv        # messy real-world-style test data
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── alembic/                # migrations
│   ├── app/
│   │   ├── main.py             # FastAPI app + CORS + bootstrap admin
│   │   ├── config.py           # env-var settings
│   │   ├── database.py         # engine/session
│   │   ├── models.py           # SQLAlchemy models (full schema)
│   │   ├── schemas.py          # pydantic request/response models
│   │   ├── auth.py             # JWT, bcrypt, admin/caller roles
│   │   ├── normalization.py    # phone/domain/name/state/address normalizers
│   │   ├── importer.py         # CSV import + strong-signal dedup linking
│   │   └── routers/
│   │       ├── auth_routes.py  # login, users
│   │       ├── imports.py      # preview, import, batch history
│   │       └── businesses.py   # list/search/get/update + source records
│   └── tests/                  # pytest suite (normalization, auth, import)
└── frontend/                   # Next.js internal dashboard
```

## Architecture

- **FastAPI + PostgreSQL + SQLAlchemy + Alembic.** REST API, JWT auth
  (admin/caller roles), structured logging, audit log table.
- **Canonical business + source records.** Every imported CSV row is preserved
  as a `source_records` row linked to one canonical `businesses` row. Duplicates
  are linked (with a human-readable reason), never deleted. Manual merge/unmerge
  comes in Milestone 2.
- **Normalization feeds matching, never replaces raw data.** Raw values stay on
  the record; `normalized_phone` (E.164), `normalized_domain`, `normalized_name`
  (legal suffixes stripped), and 2-letter state are matching columns.
- **Contacts are first-class and provenance-tracked.** Every contact records its
  source (import / website / caller_discovered / provider / manual), confidence,
  and verification status. Caller-discovered data outranks scraped data.
- **Call attempts and call discoveries are separate tables.** An attempt is the
  dial + outcome; a discovery is durable knowledge extracted from it (owner name,
  extension, best callback time, transfer instructions, gatekeeper name). The
  company never rediscovers what a caller already learned.
- **Paid enrichment is a pluggable layer (Milestone 5), off by default.** The
  system is fully functional with zero paid providers configured.

## Database schema (Milestone 1)

| Table | Purpose |
|---|---|
| `users` | admin/caller logins, bcrypt-hashed passwords |
| `businesses` | canonical business records with raw + normalized fields, lead_status, enrichment_status, do_not_call |
| `source_records` | every raw imported row, linked to its canonical business, with duplicate reason |
| `contacts` | decision-makers: role_category, email/phone types, confidence, verified_status, source |
| `call_attempts` | one row per dial: outcome, phone_called, duration, callback_at, next_action |
| `call_discoveries` | caller-learned facts: owner name, extension, direct number, callback time, transfer instructions, gatekeeper name |
| `import_batches` | per-upload stats: created / linked duplicates / error rows with line numbers |
| `audit_log` | who did what, when |

Role categories: owner, founder, president, general_manager, operations_manager,
office_manager, phone_system_decision_maker, unknown_decision_maker, gatekeeper,
employee, other.

Call outcomes: no_answer, voicemail, disconnected, wrong_number, gatekeeper,
transferred, decision_maker_conversation, decision_maker_unavailable,
callback_requested, not_interested, interested, appointment_booked,
already_has_solution, do_not_call, bad_fit, other.

## Running it

```bash
cd enrichment
cp .env.example .env        # fill in JWT_SECRET and ADMIN_PASSWORD
docker compose up --build
```

- Frontend: http://localhost:3002
- API docs (Swagger): http://localhost:8000/docs
- Log in with ADMIN_USERNAME / ADMIN_PASSWORD from your .env (the first admin is
  created automatically).

Try it: upload `sample_data/leads_sample.csv` on the Import page. It contains a
deliberate duplicate (Chuck's twice with different formatting) and mixed
state/phone/URL formats to demonstrate normalization + dedup linking.

### Running tests

```bash
cd enrichment/backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/ -v
```

Tests use in-memory SQLite — no database server needed.

### Running the backend without Docker

```bash
cd enrichment/backend
DATABASE_URL=postgresql://enrich:enrich@localhost:5433/enrichment \
  .venv/bin/alembic upgrade head
DATABASE_URL=... .venv/bin/uvicorn app.main:app --reload --port 8000
```

## API endpoints (Milestone 1)

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | /auth/login | anyone | get JWT |
| GET | /auth/me | any user | current user |
| POST | /auth/users | admin | create admin/caller accounts |
| GET | /auth/users | admin | list users |
| POST | /imports/preview | admin | CSV headers + suggested column mapping |
| POST | /imports | admin | run import with mapping |
| GET | /imports | admin | batch history with per-batch stats |
| GET | /businesses | any user | paginated list, q/state/industry/status filters |
| GET | /businesses/{id} | any user | one business |
| GET | /businesses/{id}/sources | any user | raw source rows + duplicate reasons |
| PATCH | /businesses/{id} | any user | edit (re-syncs normalized fields), audit-logged |

## Milestone plan

- **M1 (done — this code):** project init, Docker Compose, PostgreSQL, core
  models, Alembic migration, JWT auth with roles, CSV import with flexible
  mapping + normalization + strong-signal dedup linking, business listing/search,
  audit log, test suite.
- **M2:** medium-signal dedup (fuzzy name + city/address), duplicate review UI,
  manual merge/unmerge, contact CRUD, call attempt logging, call discoveries,
  caller dashboard (next lead → who to ask for → log in <30s, keyboard
  shortcuts).
- **M3:** website enrichment worker (robots.txt-respecting crawler over
  /about, /team, /contact, /staff, /leadership pages; deterministic extraction of
  names/titles/emails/extensions; every fact stored with source URL, method,
  confidence, and supporting raw text; optional LLM classification that only
  structures found text, never guesses), decision-maker ranking (configurable by
  industry), recommended calling approach (A: named DM / B: role-based / C:
  owner route / D: follow-up route), background job queue.
- **M4:** reporting — decision-maker conversations per 100 dials, answer /
  gatekeeper / transfer / callback / appointment rates, broken down by source,
  industry, state, caller, enrichment method, named-contact vs role-based, main
  line vs direct number; cost-per-outcome fields.
- **M5:** provider abstraction (enrich_company, find_people_at_company,
  enrich_person, find_email, find_phone, verify_email, health_check,
  get_remaining_credits, estimate_request_cost), mock provider, eligibility
  rules, waterfall routing with stop-after-success, per-lead/daily/monthly
  budgets, result caching, never-pay-twice.
- **M6:** GoHighLevel integration (idempotent contact/company upsert, tags,
  custom fields, notes, callback dates, lead score), production hardening, full
  test coverage, deployment docs.

## Security posture (M1)

- JWT auth on every non-login endpoint; admin-only imports and user management
- bcrypt password hashing; 8-char minimum
- Upload size limit (10 MB) and safe CSV parsing (no formula execution)
- Secrets via environment variables only; no keys in frontend code
- Audit log on login, imports, user creation, business edits
- Input validation via pydantic throughout
- Planned for M3 (crawler): SSRF protection via domain/IP validation, robots.txt
  compliance, rate limits, timeouts, clear user agent
