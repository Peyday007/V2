# Prompts and ideas from building a cold-calling system

These are the instructions I actually gave, building a lead-sourcing, cold-calling and cold-email system with an AI agent over about two weeks. The long ones are build specs. The short ones are the corrections — which is where most of the real work happened, because the first answer is rarely the one you want.

Everything specific to my setup is out: no URLs, no keys, no database, no names, no debugging. What is left should transfer to anything similar.

**The one pattern worth stealing before you read any of it:** the prompts that worked open by saying what NOT to do. Which tools are off limits, what must never be invented, what already works and has to keep working. An agent with no constraints will happily rebuild something you were happy with, or invent an integration that does not exist.

---

## The build prompts

### A lead enrichment and decision-maker discovery system

*The first big one. Note how much of it is constraints on what NOT to do — which providers are off limits, what must never be fabricated, what has to keep working. That is the part that made it usable.*

```
Build a production-ready lead enrichment and decision-maker discovery system for a cold-calling operation selling an AI receptionist/phone-answering service to small and midsized local service businesses.

The core problem:

I can already source large quantities of businesses with:
- Business name
- Main business phone
- Website
- Address
- City/state
- Industry
- Google rating/review count

I do not need another lead scraper.

I need a system that takes those existing businesses and helps my callers reach someone who can actually buy, such as:
- Owner
- Founder
- President
- General manager
- Operations manager
- Office manager
- Whoever controls phone systems, customer intake, scheduling, or software purchasing

The system should not assume that a private owner cellphone is required. The main business phone number is often enough. The purpose is to increase the number of decision-maker conversations per 100 dials while keeping enrichment costs low.

Build this as a practical internal tool, not an overengineered SaaS product.

## Main workflow

The system should follow this order:

1. Import existing leads
2. Normalize and deduplicate them
3. Perform free/light enrichment
4. Assign likely decision-makers
5. Generate a recommended calling approach
6. Allow callers to log discoveries from actual calls
7. Use paid enrichment only when justified
8. Permanently save all newly discovered decision-maker data
9. Export or push qualified leads to GoHighLevel

The system must become more valuable over time. Every name, title, extension, direct number, callback time, transfer instruction, and decision-maker discovered by a caller must be stored so the company never has to rediscover it.

# Phase 1: MVP

Build the MVP first before adding more advanced features.

Use:

- Python 3.12
- FastAPI backend
- PostgreSQL database
- SQLAlchemy ORM
- Alembic migrations
- Simple React or Next.js frontend
- Docker Compose for local deployment
- CSV import/export
- Environment variables through a .env file
- Structured logging
- Unit tests for core logic

Do not require paid APIs for the MVP.

## Lead import

Support CSV upload with flexible column mapping.

Possible incoming columns:

- business_name
- phone
- website
- address
- city
- state
- zip
- industry
- rating
- review_count
- source
- source_id

Allow the user to map CSV columns before importing.

Normalize:

- Phone numbers into E.164 where possible
- Domains by removing protocol, www, paths, and tracking parameters
- Business names by removing unnecessary punctuation and legal suffixes for matching
- State names and abbreviations
- Addresses into a consistent format

Keep the original raw values as well as normalized values.

## Deduplication

Deduplicate leads using multiple signals.

Strong duplicate signals:

- Same normalized phone number
- Same normalized domain
- Same source and source ID

Medium duplicate signals:

- Similar business name plus same city/state
- Similar business name plus same street address
- Same business name plus nearby address

Use deterministic rules first. Fuzzy matching can be added as a secondary layer.

Never silently delete duplicates.

Instead:

- Create a canonical business record
- Link duplicate source records to it
- Preserve all source data
- Show why records were considered duplicates
- Allow manual merge and unmerge

## Business and contact data model

Create database models for:

### Business

- id
- business_name
- normalized_name
- primary_phone
- normalized_phone
- website
- normalized_domain
- address
- city
- state
- zip
- industry
- rating
- review_count
- employee_count if known
- source
- source_id
- lead_status
- enrichment_status
- created_at
- updated_at
- last_contacted_at
- do_not_call
- notes

### Decision-maker/contact

- id
- business_id
- full_name
- first_name
- last_name
- title
- role_category
- email
- direct_phone
- extension
- linkedin_url
- contact_source
- confidence_score
- verified_status
- last_verified_at
- notes

Role categories should include:

- owner
- founder
- president
- general_manager
- operations_manager
- office_manager
- phone_system_decision_maker
- unknown_decision_maker
- gatekeeper
- employee
- other

### Call attempt

- id
- business_id
- contact_id if known
- caller_name
- call_started_at
- outcome
- notes
- phone_called
- duration_seconds
- recording_url if available
- next_action
- callback_at

Possible outcomes:

- no_answer
- voicemail
- disconnected
- wrong_number
- gatekeeper
- transferred
- decision_maker_conversation
- decision_maker_unavailable
- callback_requested
- not_interested
- interested
- appointment_booked
- already_has_solution
- do_not_call
- bad_fit
- other

### Decision-maker discovery

Store discoveries made during calls:

- owner_name_discovered
- title_discovered
- direct_extension_discovered
- direct_number_discovered
- email_discovered
- best_callback_time
- transfer_instructions
- gatekeeper_name
- decision_maker_schedule
- source_call_attempt_id
- discovered_by
- discovered_at
- confidence

## Free/light enrichment

Build a modular enrichment pipeline that uses public business information before any paid provider.

For each business, the system should attempt:

1. Website crawl
2. Contact page analysis
3. About page analysis
4. Team page analysis
5. Staff or leadership page analysis
6. Public email extraction
7. Public phone and extension extraction
8. Structured-data extraction
9. Social-link extraction
10. Search query generation for manual or API-assisted research

The website crawler should:

- Respect robots.txt
- Use rate limits
- Use a clear user agent
- Avoid aggressive crawling
- Crawl only a small number of relevant pages
- Stop after finding useful information
- Record the URL where each fact was found
- Store confidence scores
- Never invent missing information

Look for page paths and anchor text such as:

- /about
- /about-us
- /team
- /staff
- /leadership
- /contact
- /our-team
- /company
- /management

Extract:

- Names
- Titles
- Public emails
- Public phone numbers
- Extensions
- LinkedIn URLs
- Statements such as “family owned,” “owned by,” “founded by,” or “managed by”

Use deterministic parsing first.

Optionally use an LLM afterward to classify extracted text, but the LLM must only structure information found in the source content. It must not guess.

Every extracted field must include:

- source URL
- extraction method
- confidence score
- raw text supporting the result

## Decision-maker ranking

For each business, rank the best person to ask for.

Suggested priority:

1. Owner
2. Founder
3. President
4. General manager
5. Operations manager
6. Office manager
7. Person responsible for phones, scheduling, intake, customer service, or software
8. Unknown decision-maker

Make the ranking configurable by industry.

For very small businesses, prioritize the owner.

For larger companies, an office manager, general manager, or operations manager may be more practical.

Create a decision-maker confidence score based on:

- Exact title found on official business website
- Name confirmed by multiple sources
- Name/title discovered through a live call
- Public professional profile match
- Age of the information
- Match between person, company, location, and domain
- Whether the information was manually verified

Caller-discovered information should usually outrank scraped information.

## Recommended calling approach

For each business, generate one of these recommendations:

### Approach A: Named decision-maker available

Example:

“Call the main line and ask for Sarah Johnson, the office manager.”

### Approach B: Role known, name unknown

Example:

“Ask for whoever manages phone systems, scheduling, or customer intake.”

### Approach C: Small business owner route

Example:

“Ask whether the owner is available. If unavailable, ask for the best callback time and the owner’s name.”

### Approach D: Follow-up route

Example:

“Previous call identified Mike as the owner. He is usually available after 3:00 PM. Ask to be transferred directly.”

Do not generate cheesy or overly long sales scripts.

The recommendation should be short and operational.

## Caller workflow

Build a caller dashboard.

The caller should see:

- Business name
- Industry
- Main phone
- Website
- Location
- Known decision-maker
- Recommended person or role to ask for
- Previous call history
- Best callback time
- Transfer instructions
- Notes
- Enrichment confidence
- Current status

The caller should be able to log a call in under 30 seconds.

Provide quick-action buttons for common outcomes.

When a caller records new decision-maker information, update the contact record and mark the source as caller-discovered.

The system should preserve a full history of changes.

## Decision-maker conversation metric

The most important metric is:

Decision-maker conversations per 100 dials

Build reporting for:

- Total dials
- Answer rate
- Gatekeeper rate
- Transfer rate
- Decision-maker conversation rate
- Callback rate
- Appointment rate
- Appointment rate per decision-maker conversation
- No-answer rate
- Voicemail rate
- Wrong-number rate
- Disconnected-number rate
- Do-not-call rate

Break metrics down by:

- Lead source
- Industry
- State
- Caller
- Enrichment method
- Named-contact vs role-based calling
- Main business line vs direct number
- Date range

This should let us compare:

- Calling only the main business number
- Calling with a known decision-maker name
- Calling a direct number
- Paid-enriched contacts
- Publicly enriched contacts
- Caller-discovered contacts

Do not assume paid enrichment is better. The dashboard should prove whether it improves conversations and appointments.

## Cost tracking

Track enrichment cost per business and per provider.

Metrics:

- Cost per enriched lead
- Cost per valid phone
- Cost per valid email
- Cost per named decision-maker
- Cost per decision-maker conversation
- Cost per appointment
- Match rate
- Failure rate
- Stale-data rate

The system should help determine whether owner/direct-contact enrichment actually justifies its cost.

# Phase 2: Paid enrichment architecture

After the MVP works, add a provider abstraction layer.

Do not hardcode the system around Apollo, SignalHire, RocketReach, People Data Labs, Hunter, Prospeo, or any specific company.

Create a generic provider interface such as:

- enrich_company()
- find_people_at_company()
- enrich_person()
- find_email()
- find_phone()
- verify_email()
- health_check()
- get_remaining_credits()
- estimate_request_cost()

Each provider adapter should be isolated.

The application must work even when no paid providers are configured.

Add provider configuration through environment variables and an admin page.

Possible providers can be added later, but begin with mock adapters and clear documentation.

## Paid enrichment routing logic

Paid enrichment should not run automatically on every business.

Create configurable eligibility rules.

Example rules:

- Correct target industry
- Valid working main phone
- Legitimate website
- Minimum review count
- Not a franchise
- Not previously contacted
- No known decision-maker
- High enough lead score
- Caller could not reach the decision-maker after a defined number of attempts
- Business appears large enough to afford the product

Example routing:

1. Use free website enrichment
2. Check existing internal database
3. Check caller-discovered records
4. Check cached provider results
5. If still unresolved and eligible, call one paid provider
6. Stop after a successful high-confidence match
7. Only call another provider if the first provider fails or confidence is low
8. Never pay twice for the same exact lookup unless manually approved or data is stale

Build a configurable waterfall, but do not require subscriptions to multiple providers.

Support:

- Single-provider mode
- Multi-provider fallback mode
- Manual approval mode
- Maximum spend per lead
- Daily budget
- Monthly budget
- Minimum confidence threshold
- Stop-after-success
- Cache duration

## Internal knowledge base

Before making any paid enrichment request, search the internal database.

Match on:

- Domain
- Business phone
- Business name and city
- Address
- Prior business names
- Parent company
- Known contacts

If a decision-maker was previously discovered, reuse it.

Preserve old contacts but mark them inactive or stale instead of deleting them.

## Contact verification

Create statuses:

- unverified
- likely
- verified_by_public_source
- verified_by_live_call
- verified_by_email
- verified_by_provider
- stale
- invalid

Caller verification should be treated as strong evidence.

Phone numbers should include type where known:

- main business
- direct office
- mobile
- extension
- unknown

Emails should include:

- work email
- generic business email
- personal email
- unknown

Do not expose private personal information unnecessarily. Only store data needed for legitimate B2B outreach.

## Lead prioritization

Create a transparent score for the AI receptionist offer.

Possible positive signals:

- Business relies heavily on inbound phone calls
- Open evenings or weekends
- Emergency services
- Multiple service areas
- 20–500 reviews
- Reviews mention missed calls, slow callbacks, no answer, scheduling issues, or poor communication
- No online booking
- No live chat
- Generic voicemail
- Growing team
- Multiple locations
- Website prominently tells customers to call

Possible negative signals:

- Permanently closed
- Disconnected phone
- Obvious national franchise
- Sophisticated existing scheduling/chat/AI system
- No meaningful inbound-call need
- Extremely small or inactive operation
- Duplicate
- Previously marked bad fit
- Do not call

Make weights configurable.

Store an explanation for every score.

Do not let an LLM generate an unexplained score.

## GoHighLevel integration

Build a GHL integration layer.

Support:

- Create or update contacts
- Create or update companies if supported by the configured API
- Add tags
- Populate custom fields
- Assign callers
- Push notes
- Push decision-maker details
- Push callback dates
- Push lead source
- Push lead score
- Push enrichment source
- Push enrichment confidence
- Push last call outcome

Prevent duplicate contact creation.

Use idempotency where possible.

Keep integration code separated from core business logic.

## API endpoints

Create clean REST endpoints for:

- Import leads
- List businesses
- Search businesses
- View business
- Update business
- Merge businesses
- Unmerge businesses
- Run free enrichment
- Queue enrichment jobs
- View enrichment results
- Add/edit decision-maker
- Log call attempt
- Add call discovery
- Schedule callback
- Export leads
- View performance metrics
- Configure provider rules
- Configure scoring
- Push records to GHL

Use background jobs for website crawling and enrichment.

Choose either Celery with Redis or a simpler reliable job queue.

## Admin dashboard

The admin should be able to:

- Upload lead lists
- Review import errors
- Review duplicate suggestions
- Start enrichment jobs
- Set enrichment budgets
- Configure provider priority
- Configure qualification rules
- Review low-confidence contacts
- Review caller performance
- Review source performance
- View cost metrics
- Export selected records
- Push selected records to GoHighLevel

## Security

Implement:

- Authentication
- Admin and caller roles
- Password hashing
- Input validation
- Rate limiting
- Audit logging
- Safe CSV handling
- Secrets only in environment variables
- No API keys in frontend code
- Protection against SSRF in website crawling
- Domain and IP validation before crawling
- Request timeouts
- File size limits
- Error handling without leaking secrets

## Compliance and data handling

Build reasonable safeguards for legitimate B2B outreach.

Include:

- Do-not-call flag
- Suppression list
- Opt-out notes
- Source attribution
- Contact-data deletion
- Data retention settings
- Audit trail
- Ability to export or delete a business/contact record
- No bypassing website protections
- No credential theft
- No unauthorized scraping behind logins
- No CAPTCHA bypass
- No collection of unnecessary sensitive personal information

## User experience

The system should be fast and simple.

The caller interface should not feel like a complex CRM.

A caller should be able to:

1. Open the next lead
2. See exactly who to ask for
3. Call
4. Log the outcome
5. Add any information discovered
6. Move immediately to the next lead

Use keyboard shortcuts where useful.

## Deliverables

Create:

1. Complete project structure
2. Database schema
3. Alembic migrations
4. FastAPI backend
5. Frontend dashboard
6. Docker Compose setup
7. CSV import template
8. Sample test dataset
9. Unit and integration tests
10. API documentation
11. Setup guide
12. Environment variable template
13. GHL integration stub
14. Paid-provider adapter interface
15. Mock enrichment provider
16. Website enrichment module
17. Deduplication module
18. Scoring module
19. Reporting dashboard
20. Clear README

## Development order

Build in this order:

### Milestone 1
- Project initialization
- Docker Compose
- PostgreSQL
- Core database models
- Migrations
- Authentication
- CSV import
- Business listing

### Milestone 2
- Normalization
- Deduplication
- Manual merge
- Decision-maker records
- Call attempt logging
- Caller dashboard

### Milestone 3
- Website enrichment
- Source URLs
- Confidence scoring
- Recommended calling approach
- Background jobs

### Milestone 4
- Reporting
- Decision-maker conversations per 100 dials
- Caller and source comparisons
- Cost fields

### Milestone 5
- Provider abstraction
- Mock paid provider
- Budget controls
- Waterfall routing
- Caching

### Milestone 6
- GoHighLevel integration
- Production hardening
- Full test coverage
- Deployment documentation

At the end of each milestone:

- Run tests
- Fix errors
- Show what was completed
- Explain how to run it
- List remaining work
- Do not move forward with broken code

## Important product decisions

Do not build this around the belief that the owner’s private cellphone is necessary.

The objective is:

“Reach more people who can approve or influence the purchase.”

The system should treat all of the following as valuable:

- Owner reached through main business line
- Transfer to general manager
- Office manager with purchasing authority
- Operations manager
- Named callback time
- Direct extension
- Gatekeeper instructions
- Caller-discovered owner name
- Direct number when legitimately obtained

The system’s central question should always be:

“How many dials does it take to have a conversation with someone who can buy?”

Start by generating the proposed repository structure, architecture, database schema, and implementation plan. Then begin Milestone 1 immediately.


also the one yo are working on is the dark one, build it so it looks like the brown one. make it look more fleshed out. the columns dont even reach the bottom
```

### Sourcing: build the pipeline, do not import the old data

*Written after an empty database looked like a bug. Says plainly what the empty state means and what to build instead of guessing.*

```
The empty database is expected because this is a new system.

Do not import the old leads.

The previous leads were generated automatically inside the old application, and this new application must do the same thing independently.

The application’s core workflow must be:

1. Generate businesses
2. Save them to the database
3. Normalize and deduplicate them
4. Run free decision-maker enrichment
5. Compare results across multiple public sources
6. Stop once a sufficiently confident decision-maker is found
7. Place the enriched lead into the correct campaign or sales stage
8. Make it available for packet creation and calling

This must happen inside the website.

The user should not need to manually import CSV files as the normal operating workflow.

==================================================
ENGINE 1 — LEAD GENERATION
==================================================

Build a lead-generation engine inside the application.

The admin should be able to create a sourcing campaign with fields such as:

- industry
- state
- city or metro
- radius
- maximum lead count
- minimum rating
- minimum review count
- maximum review count
- require website
- exclude franchises
- search terms
- campaign name

Example:

Campaign:
Metro Detroit Roofing

Search terms:
- roofer
- roofing contractor
- roof repair
- commercial roofing

Target:
Detroit metro, Michigan

Lead target:
500

When the admin starts the campaign, the system should search for businesses automatically.

Primary source:

- Google Places API

Possible later sources:

- state contractor-license databases
- trade directories
- local business directories
- chamber directories
- manufacturer/dealer directories

Do not scrape Google Maps HTML directly.

Use official APIs or approved sources where available.

For every business found, save:

- business name
- main phone
- website
- address
- city
- state
- zip
- category
- rating
- review count
- Google place ID
- source
- source query
- source campaign
- created_at
- updated_at

Generate leads in the background so the user can leave the page.

Show campaign progress:

- searches completed
- businesses found
- new unique businesses
- duplicates skipped
- businesses with websites
- businesses queued for enrichment
- businesses successfully enriched
- failures
- estimated completion

==================================================
SEARCH COVERAGE
==================================================

Do not run one broad search and stop.

Create a search-coverage system.

For each campaign, generate combinations of:

- industry keyword
- city
- suburb
- ZIP code where useful
- geographic grid or radius
- category variant

Examples:

- roofing contractor Detroit MI
- roofer Dearborn MI
- roof repair Southfield MI
- commercial roofer Sterling Heights MI

Track every search combination so the system does not repeatedly run the same search unnecessarily.

Save:

- search query
- location
- page token or pagination state
- execution status
- records returned
- unique records added
- last executed
- retry count
- error

Continue searching until one of these conditions is met:

- target lead count reached
- all planned combinations exhausted
- API budget reached
- admin stops the campaign

==================================================
NORMALIZATION AND DEDUPLICATION
==================================================

Before creating a new business record, check:

Strong duplicate keys:

- Google place ID
- normalized phone
- normalized domain

Secondary duplicate keys:

- normalized business name plus city
- normalized name plus address
- similar name plus nearby coordinates

Do not create multiple records for the same business because it appeared in different searches.

Preserve all source-query history.

If a business already exists:

- link it to the new campaign
- do not duplicate it
- reuse any previous enrichment
- update stale business fields where appropriate

==================================================
ENGINE 2 — FREE DECISION-MAKER ENRICHMENT
==================================================

Once a business is saved, automatically queue it for enrichment.

The system is not only looking for a private phone number.

The main goal is to identify the best person or role for the caller to ask for.

Useful outcomes include:

- owner
- founder
- president
- managing member
- general manager
- operations manager
- office manager
- customer-service manager
- scheduling manager
- unknown decision-maker role
- named gatekeeper and transfer instructions

The enrichment engine should run a waterfall of sources.

Stop as soon as enough reliable information is found.

==================================================
FREE ENRICHMENT WATERFALL
==================================================

Run these steps in order:

STEP 1 — INTERNAL DATABASE

Before external research, search the existing internal database using:

- domain
- phone
- business name and city
- address
- prior business names
- parent company

Reuse any previous:

- decision-maker
- title
- callback time
- extension
- email
- direct phone
- gatekeeper instructions
- caller discoveries

Do not pay or research twice for the same information.

STEP 2 — BUSINESS WEBSITE

Crawl only relevant public pages:

- homepage
- about
- about us
- team
- staff
- leadership
- management
- contact
- company
- our story

Extract:

- person names
- titles
- owner statements
- founder statements
- management names
- public emails
- public phones
- extensions
- LinkedIn links
- structured data
- company size clues

Store:

- source URL
- supporting text
- extraction method
- confidence
- date found

Never invent missing information.

STEP 3 — PUBLIC BUSINESS REGISTRIES

Create a registry-adapter system.

Possible sources:

- Secretary of State business registry
- corporation registry
- LLC registry
- state contractor-license registry
- professional-license registry

Search using:

- legal business name
- DBA name
- address
- city/state
- phone where supported

Extract fields such as:

- registered business name
- active status
- member
- manager
- managing member
- president
- officer
- license holder
- qualifying individual
- owner where explicitly available

Registry data must not automatically be treated as perfect.

A registered agent is not necessarily the owner.

Classify registry roles accurately.

STEP 4 — PUBLIC DIRECTORIES

Add modular adapters for public sources such as:

- BBB profile
- chamber directory
- trade-association directory
- manufacturer dealer profile
- company profile pages
- local business directories

Only use sources allowed by their access terms.

STEP 5 — SEARCH ENGINE RESEARCH

Generate search queries such as:

- "[business name]" owner
- "[business name]" founder
- "[business name]" president
- "[business name]" manager
- "[business name]" LinkedIn
- site:linkedin.com/in "[business name]" owner
- "[phone number]"
- "[domain]" owner

Use a proper search API.

Do not aggressively scrape search-result HTML.

Collect candidate evidence and compare it against:

- business name
- domain
- city
- state
- industry
- website
- phone

STEP 6 — PROFESSIONAL PROFILE MATCHING

When public search discovers professional profiles, evaluate:

- current company
- title
- location
- company domain
- employment dates
- whether the person appears current or former

Do not accept a person solely because they share a company name.

==================================================
SOURCE COMPARISON AND RESOLUTION
==================================================

The system must compare evidence from multiple sources.

Example:

Website:
Mike Turner — Founder

State registry:
Michael Turner — Managing Member

LinkedIn:
Mike Turner — Owner at Turner Roofing

These should be resolved into one likely contact:

Michael “Mike” Turner
Owner / Founder / Managing Member

Store each underlying source separately.

Create a contact-resolution process that:

- normalizes names
- detects likely aliases
- compares company and location
- merges supporting evidence
- flags contradictions
- calculates confidence

Confidence should increase when:

- official website confirms title
- live caller confirms person
- multiple independent sources agree
- domain and company match
- location matches
- information is recent

Confidence should decrease when:

- source is old
- person is marked former
- only a registered-agent record exists
- company name is ambiguous
- locations conflict
- sources disagree

Do not hide conflicting evidence.

==================================================
SUCCESS CONDITIONS
==================================================

The enrichment engine may stop when it has one of these:

SUCCESS LEVEL A

- named decision-maker
- clear title
- high confidence

SUCCESS LEVEL B

- named probable decision-maker
- moderate confidence
- main business phone available

SUCCESS LEVEL C

- no name, but correct decision-making role identified
- recommended person to ask for

Examples:

“Ask for Michael Turner, the owner.”

“Ask for the office manager who handles phones and scheduling.”

“Ask whether the managing member is available.”

The system does not need a private cell number to mark enrichment successful.

==================================================
PAID ENRICHMENT
==================================================

Do not require paid enrichment for the first version.

Create an interface for paid providers later.

Paid enrichment should only run when:

- free sources failed
- business passes qualification rules
- admin budget allows it
- direct contact data is considered valuable
- the lookup has not already been purchased

The default workflow must work without Apollo, SignalHire, RocketReach, or PDL.

==================================================
ENGINE 3 — LEAD STATUS AND ROUTING
==================================================

Each business should move through machine-processing statuses:

- discovered
- normalized
- duplicate_review
- enrichment_queued
- enriching
- decision_maker_found
- role_only_found
- enrichment_failed
- ready_for_calling
- assigned_to_packet
- contacted
- archived

These machine statuses are separate from sales stages.

When enrichment succeeds:

- save the contact
- create the recommended calling instruction
- mark ready_for_calling
- attach the business to its sourcing campaign
- make it eligible for call-packet generation

Example recommendation:

“Call the main line and ask for Mike Turner, owner.”

If no name was found:

“Ask for whoever handles phone systems, customer intake, or scheduling.”

==================================================
AUTOMATIC BOARD POPULATION
==================================================

The sales board must populate from businesses created by the lead-generation engine.

The workflow should be:

Admin starts sourcing campaign

↓

Businesses are found

↓

Businesses are saved

↓

Enrichment runs automatically

↓

Qualified records become ready for calling

↓

They appear in the appropriate admin view

↓

Admin generates caller packets

There should be no manual CSV step required.

The board should update as background jobs finish.

Use realtime updates, polling, or reliable query invalidation.

==================================================
CALL PACKET INTEGRATION
==================================================

Only leads marked ready_for_calling should be eligible for packets.

Admins should be able to filter packet generation by:

- campaign
- industry
- state
- city
- decision-maker found
- role only found
- confidence
- lead score
- never called
- callback status
- source

Example:

Campaign:
Metro Detroit Roofing

Filter:
Decision-maker found

Packet size:
200

Assign to:
Caller A

Generate a locked packet.

==================================================
BACKGROUND JOBS
==================================================

Use a reliable job queue for:

- lead-generation searches
- pagination
- website crawling
- registry lookups
- search-engine research
- contact resolution
- enrichment retries
- campaign completion

Jobs must be:

- idempotent
- retryable
- observable
- rate-limited
- resumable after deployment or failure

Do not depend on a browser tab remaining open.

==================================================
ADMIN CONTROLS
==================================================

Add admin pages for:

Sourcing Campaigns

- create campaign
- start
- pause
- resume
- stop
- view progress
- view cost
- view query coverage
- view errors

Enrichment

- queued
- processing
- successful
- role only
- failed
- conflicting
- low confidence
- manual review

Businesses

- all generated businesses
- source history
- enrichment evidence
- decision-maker
- recommended calling approach
- packet status

==================================================
DIAGNOSTICS
==================================================

Add clear diagnostics.

Show:

- total businesses generated
- duplicates skipped
- enrichment queued
- enrichment completed
- decision-makers found
- role-only results
- enrichment failures
- average enrichment time
- source success rate
- Google Places API errors
- registry errors
- search API errors
- background worker status

Do not show an empty board without explaining whether:

- no sourcing campaign has been run
- sourcing is still running
- no leads were found
- leads are enriching
- leads failed qualification
- leads are already assigned
- filters are hiding them

==================================================
IMPLEMENTATION ORDER
==================================================

Do not try to build everything at once.

MILESTONE 1

- inspect current repository
- inspect existing database schema
- preserve existing board and auth functionality
- add sourcing_campaigns table
- add search_coverage table
- add business/source tables
- add enrichment-job tables
- add canonical machine statuses
- add background job infrastructure

MILESTONE 2

- Google Places lead generation
- campaign configuration
- pagination and coverage
- normalization
- deduplication
- automatic database insertion
- campaign progress dashboard

MILESTONE 3

- website enrichment
- page discovery
- name/title extraction
- evidence storage
- confidence scoring
- automatic routing to ready_for_calling

MILESTONE 4

- state registry adapter architecture
- first supported registry
- contractor-license adapter architecture
- public directory adapters
- search API integration
- cross-source comparison

MILESTONE 5

- contact resolution
- conflict handling
- caller recommendation generation
- packet eligibility integration
- automatic board updates

MILESTONE 6

- paid-provider interface
- budget controls
- analytics
- production hardening

==================================================
FIRST RESPONSE REQUIRED
==================================================

Do not begin coding immediately.

First report:

1. What lead-generation functionality already exists in this repository
2. What enrichment functionality already exists
3. Which Supabase tables already exist
4. What can be reused from the previous implementation
5. What is currently mocked or missing
6. Proposed schema additions
7. Proposed background-job approach
8. Google Places API requirements
9. Search API requirements
10. Registry sources that can realistically be supported first
11. Security and rate-limit risks
12. Exact Milestone 1 implementation plan

Then begin Milestone 1 only.

Do not import the old 17 leads.

Do not hardcode sample leads.

The new system must generate, enrich, save, and display its own real leads.
```

### Run the heavy work as server-side jobs

*A short structural correction that changed the whole architecture: move lead generation and enrichment off the request path.*

```
The Google Places API key is configured in Vercel as:

GOOGLE_PLACES_API_KEY

Change the implementation plan so lead generation and enrichment run as separate asynchronous stages.

Do not make Google Places wait for enrichment before saving or displaying a business.

The correct workflow is:

Google Places search
↓
Business saved immediately
↓
Normalize and deduplicate
↓
Quick qualification
↓
Queue enrichment job
↓
Enrichment runs in the background
↓
Decision-maker result is saved when available
↓
Lead becomes eligible for caller packets

The purpose is to let the system keep generating businesses quickly while enrichment continues independently.

==================================================
MILESTONE 2 — LEAD GENERATION ONLY
==================================================

Build Milestone 2 around fast business discovery and persistent storage.

Requirements:

1. Admin can create a sourcing campaign with:
   - campaign name
   - industry
   - city, metro, state, ZIPs, or radius
   - search terms
   - target lead count
   - minimum rating
   - minimum review count
   - maximum review count
   - require website
   - exclude franchises
   - request budget or request cap

2. Generate keyword and location search combinations automatically.

3. Query Google Places API (New) using the server-side environment variable:
   GOOGLE_PLACES_API_KEY

4. Support pagination and continuation jobs.

5. Save each business as soon as it is returned by Google.

6. Normalize:
   - phone
   - domain
   - business name
   - address
   - city
   - state
   - ZIP

7. Deduplicate before insertion using:
   - place_id
   - normalized phone
   - normalized domain
   - normalized business name plus city/address as secondary checks

8. Do not create duplicate businesses if they appear in multiple searches.

9. Preserve every search query and campaign source association.

10. Assign machine statuses in this order:

   discovered
   normalized
   enrichment_queued

11. After a business passes normalization and quick qualification, create an enrichment job.

12. Do not perform website crawling, registry lookup, search-engine research, or paid enrichment inside the Places request.

13. The lead-generation job must finish quickly and release control even if enrichment is still pending.

14. The campaign dashboard should update live with:
   - searches planned
   - searches completed
   - API requests used
   - businesses returned
   - unique businesses saved
   - duplicates skipped
   - qualification failures
   - enrichment jobs queued
   - errors
   - current campaign status

15. The system must be resumable after:
   - deployment
   - timeout
   - worker crash
   - API error

16. Use continuation jobs for additional Places pages and remaining search combinations.

17. Enforce:
   - maximum API requests per campaign
   - daily request cap
   - campaign stop button
   - retry limits
   - exponential backoff

18. Never expose the Google API key to the frontend.

19. Never hardcode the key.

20. Do not use Google Maps HTML scraping.

==================================================
QUICK QUALIFICATION
==================================================

Before queuing enrichment, perform only fast deterministic checks.

Examples:

- has a valid business name
- has a usable main phone
- not permanently closed
- target category or keyword match
- rating/review thresholds met
- website requirement met if enabled
- not already archived
- not on suppression list
- not an obvious duplicate

Do not make expensive LLM or crawler calls during this step.

If a business fails qualification, save the reason.

==================================================
ENRICHMENT HANDOFF
==================================================

After a business is saved and qualified:

Create an idempotent enrichment job using the lead ID.

Example job type:

enrich_lead

Payload:

{
  "lead_id": "...",
  "campaign_id": "..."
}

The same lead must not receive duplicate active enrichment jobs.

Set:

machine_status = 'enrichment_queued'

The enrichment worker will be implemented in Milestone 3.

For now, create the queue entries and show their status.

==================================================
BOARD BEHAVIOR
==================================================

The admin board should not remain empty while enrichment is pending.

Businesses should appear in the admin system as soon as they are saved.

Show their machine status clearly:

- Discovered
- Normalized
- Waiting for enrichment
- Enriching
- Decision-maker found
- Role only found
- Enrichment failed
- Ready for calling

Do not make all newly generated businesses immediately appear in caller packets.

Only records marked:

ready_for_calling

should be eligible for packet generation.

==================================================
MILESTONE 3 — ENRICHMENT WORKER
==================================================

After Milestone 2 is tested and working, build enrichment as its own worker pipeline.

The enrichment workflow will be:

Internal database
↓
Business website
↓
Public registry
↓
Contractor-license registry
↓
Public directories
↓
Search API
↓
Professional profile matching
↓
Contact resolution
↓
Recommended person or role to ask for

Each enrichment step must:

- save evidence
- save source URL
- save supporting text
- save confidence
- preserve conflicting evidence
- stop when sufficient confidence is reached

Enrichment results should update the existing lead record asynchronously.

Possible final statuses:

decision_maker_found
role_only_found
enrichment_failed
ready_for_calling

The main business phone is enough for calling.

A private owner cellphone is not required for enrichment success.

==================================================
IMPORTANT IMPLEMENTATION RULE
==================================================

Do not build one giant synchronous route that:

1. searches Google
2. crawls the website
3. searches registries
4. calls search APIs
5. resolves the contact
6. waits until everything is finished

That architecture will be slow, fragile, difficult to retry, and likely to time out on Vercel.

Use separate persisted jobs:

- plan_search_tasks
- execute_places_search
- continue_places_pagination
- normalize_lead
- qualify_lead
- queue_enrichment
- enrich_lead

Every job must be:

- idempotent
- retryable
- observable
- resumable
- rate-limited

==================================================
FIRST RESPONSE
==================================================

Before coding, inspect the current implementation and report:

1. What parts of Milestone 2 already exist
2. Whether the Google Places environment variable is available server-side
3. Which tables and jobs already support this flow
4. What schema changes are required
5. How the board will show businesses before enrichment finishes
6. How duplicate enrichment jobs will be prevented
7. Exact files you plan to change

Then implement Milestone 2 only.

Do not begin Milestone 3 until:
- real businesses are being generated
- they persist after refresh
- campaign progress is accurate
- duplicates are prevented
- enrichment jobs are being queued successfully
- all tests pass
```

### The caller dialer, for an AI receptionist campaign

*Most of this is context about who is being called and why — the part that decides whether the output is any good.*

```
pdate the existing caller dialer for an AI receptionist cold-calling campaign.
Important lead context
The lead generator only targets local service businesses with 600 Google reviews or fewer. These businesses are usually independently owned and owner-operated.
Because of that, the default decision-maker should be the owner, not a corporate call-center manager or complicated title hierarchy.
Do not rebuild the dialer or dramatically change its design. Preserve the existing dark charcoal/yellow visual style and current two-column layout. Improve the workflow, data capture and caller guidance.
1. Update “Who to Ask For”
Replace the current generic section with dynamic instructions.
When an owner name is known
Display:
WHO TO ASK FOR
Ask for [Owner Name], the owner. If they are unavailable, find out the best day and time to reach them directly.
Also display any known title, extension or previous calling information.
When no owner name is known
Display:
WHO TO ASK FOR
Ask whether the owner is available. If not, get the owner’s name and the best day and time to call back.
Backup decision-maker logic
The owner is always the first target.
Only recommend another person if the business confirms that someone else controls the decision. Possible backups:

* General manager
* Office manager
* Operations manager
* Whoever manages incoming calls, scheduling or customer intake

Do not assume larger-company title hierarchies because these leads are primarily owner-operated businesses.
2. Add a Clear Call Objective
Add a compact section underneath “Who to Ask For.”
Before the owner is identified:
CALL OBJECTIVE
Identify the owner, get transferred to them or obtain a specific time when they can be reached.
After the owner is identified but not previously reached:
CALL OBJECTIVE
Reach [Owner Name], briefly identify whether missed or after-hours calls are costing the business opportunities and attempt to book a demo.
After a previous owner conversation:
CALL OBJECTIVE
Continue the previous conversation and complete the next step shown in the call history.
The objective should update dynamically based on existing lead intelligence and previous outcomes.
3. Add Previous Call History
Add a compact “Previous Activity” section on the left side of the dialer.
Show:

* Total call attempts
* Date and time of the last attempt
* Previous caller
* Previous outcome
* Previous notes
* Owner name, if discovered
* Best known callback time
* Last promised next step
* Previous objections
* Upcoming scheduled callback

Example:
PREVIOUS ACTIVITY
July 24, 3:42 PM — Gatekeeper said owner Mike is normally available before 9:00 AM. Call back tomorrow morning.
Do not make callers open another page to see the most important history.
4. Make Outcomes Open Structured Forms
Do not allow every outcome to save only a free-text note. Each outcome must collect the information relevant to that outcome.
No Answer
Optional fields:

* Rang with no answer
* Call disconnected
* Business appeared closed
* Other note

Automatically:

* Increase attempt count
* Record the call time
* Schedule the lead for another attempt based on retry rules

Voicemail
Fields:

* Voicemail left: Yes or No
* Message type used
* Optional note

Automatically:

* Record voicemail attempt
* Increase attempt count
* Prevent the same caller from repeatedly leaving identical voicemails

Gatekeeper Only
Required fields:

* Gatekeeper name, or “Name not provided”
* Was the owner identified? Yes or No
* Owner name, when discovered
* Best day to reach the owner
* Best time to reach the owner
* Extension or direct number, when provided
* What the gatekeeper said

This outcome should permanently update the lead when the owner’s name or availability is learned.
Transferred
Required fields:

* Transferred to whom?
* Person’s name
* Person’s role
* Did the transfer connect successfully?
* What happened after the transfer?

If the owner answers, allow the caller to continue into the Decision-Maker Conversation workflow without creating a separate disconnected record.
Decision-Maker Conversation
Only use this outcome when the caller actually spoke with the owner or another confirmed decision-maker.
Required fields:

* Decision-maker name
* Role
* Current call-answering situation
* Main problem discovered
* Interest level
* Objection or concern
* Agreed next step

Use simple selectable options where possible.
Current call-answering situation

* Owner answers most calls
* Office staff answers
* Calls go to voicemail
* Uses an answering service
* Uses another AI receptionist
* Unsure
* Other

Main problem

* Missed calls
* After-hours calls
* Staff interruptions
* Slow callback times
* Scheduling problems
* Lead follow-up problems
* No major problem identified
* Other

Interest level

* Strong interest
* Mild interest
* Unsure
* Not interested

Callback Requested
Required fields:

* Who requested the callback?
* Person’s name
* Person’s role
* Exact callback date
* Exact callback time or time window
* Reason for the callback
* Caller responsible for following up

A callback is not an appointment.
Create a scheduled callback record and return the lead to the responsible caller at the appropriate time.
Appointment Set
An appointment must only be saved when the owner or confirmed decision-maker agrees to a specific meeting or demonstration.
Required fields:

* Decision-maker name
* Confirmed role
* Appointment date
* Appointment time
* Time zone
* Phone number
* Email, when available
* Product discussed
* Reason for the meeting
* Main pain point
* Confirmation method
* Additional notes for the person taking the appointment

Require the caller to confirm:
I spoke with the owner or a confirmed decision-maker, and they agreed to a specific meeting date and time.
Do not allow gatekeeper callbacks, vague follow-ups, “send me information” or “call another time” to be marked as appointments.
Not Interested
Required fields:

* Who said they were not interested?
* Owner/decision-maker or gatekeeper?
* Reason
* Should another attempt be made later?
* Optional follow-up date
* Notes

Reasons:

* Already has a solution
* Owner handles calls personally
* No missed-call problem
* Too expensive
* Does not trust AI
* Bad timing
* Needs more information
* Corporate/franchise decision
* Gatekeeper rejected the call
* Other

If only a gatekeeper says “not interested,” do not automatically classify the entire company as permanently lost unless the gatekeeper confirms they have authority.
Bad Number
Required fields:

* Disconnected
* Wrong business
* Number belongs to another person
* Fax line
* Other

Mark the phone number as invalid without automatically deleting the entire company lead.
Do Not Call
Require confirmation before saving.
Required fields:

* Who requested no further contact?
* Owner/decision-maker, employee or unknown
* Reason
* Optional note

Immediately suppress the company and phone number from every caller queue.
5. Replace “Learned Something?” With Lead Intelligence
Rename the current section:
UPDATE LEAD INTELLIGENCE
Allow the caller to save:

* Owner name
* Owner title
* Gatekeeper name
* Best calling day
* Best calling time
* Direct number
* Extension
* Email
* Current answering setup
* Existing answering provider
* Number of office staff
* After-hours process
* Decision-maker other than owner
* Franchise or independently owned
* Additional company information

Information entered here must permanently update the company record and appear for every future caller.
Show saved discoveries in a readable format:
Owner identified: Mike Reynolds
Best time to call: Weekdays before 9:00 AM
Current setup: Calls go to voicemail after 5:00 PM
Existing provider: None
6. Improve the Call Tip Section
Keep it compact and collapsible.
Provide three sections:
Opening
“Quick question—could I speak with the owner for a moment?”
When the owner’s name is known:
“Hi, could I speak with [Owner Name] for a moment?”
Owner Discovery
“Who is the owner, and when is usually the best time to reach them?”
Owner Conversation
“I’m calling because we help local service businesses answer missed and after-hours calls without adding another full-time employee. What normally happens when nobody can answer your phone?”
Do not show callers a huge script by default. The initial screen should only show the immediate next line they need.
7. Add Objection Assistance
Add a compact “Objections” button.
Options:

* We already answer every call
* We already have an answering service
* The owner is unavailable
* Send some information
* We are not interested in AI
* How much does it cost?
* We do not receive enough calls
* We tried something similar before
* Call back later

Clicking an objection should show:

* One short recommended response
* One follow-up question
* The recommended next outcome

Do not provide long paragraphs that cause the caller to sound scripted.
8. Add Operational Information
Display the following near the business information:

* Current local time for the business
* Business hours, when available
* Whether the business is currently open
* Total previous attempts
* Best known calling time
* Website button
* Google Maps button
* Copy phone number button
* Company time zone

Add:

* Pause queue
* Skip lead with required reason
* Call timer
* Recording status, when supported
* Daily completed-call count
* Scheduled callbacks remaining
* Leads remaining

9. Add Retry Rules
Automatically schedule another attempt after:

* No answer
* Voicemail
* Gatekeeper without owner access
* Requested callback

Do not call at the exact same time every day.
Use different calling windows across attempts:

* Early morning
* Late morning
* Early afternoon
* Late afternoon

Respect the business’s local time and operating hours.
When a specific callback time is provided, that time overrides the standard retry schedule.
10. Keep the Workflow Simple
The dialer should follow this sequence:

1. Understand who the caller needs to reach
2. Review what happened previously
3. Make the call
4. Select an outcome
5. Capture structured information
6. Schedule the exact next action
7. Save new lead intelligence
8. Load the next lead

The dialer is not intended for complex enterprise account mapping. It is designed for owner-operated local service businesses with 600 reviews or fewer.
The primary goal is to increase the number of actual owner conversations and prevent weak callbacks, gatekeeper interactions or vague interest from being counted as appointments.
Acceptance Criteria
The update is complete when:

* The owner is the default target on every lead.
* Known owner names automatically appear in the caller instructions.
* Previous activity is visible without leaving the dialer.
* Each outcome opens the correct structured fields.
* Callbacks require a date and time.
* Appointments require a confirmed decision-maker and scheduled meeting.
* Gatekeeper rejection is distinguishable from owner rejection.
* New names, titles and callback times permanently update the lead.
* DNC requests suppress the lead for all callers.
* Retry attempts occur during different local calling windows.
* The existing design and overall dialer simplicity are preserved.


Medium
```

### Organizational memory and adaptive analytics — plan first

*"Do not begin coding immediately." The instruction that produced a design instead of a pile of code.*

```
We are adding two major systems to the existing sales platform:

1. Organizational Memory
2. Adaptive Analytics and Optimization

Do not begin coding immediately.

First:

1. Read the full specification.
2. Review the existing application architecture and database.
3. Identify what already exists that can be reused.
4. Identify conflicts, missing data, migration risks, and architectural weaknesses.
5. Propose an implementation plan.
6. Preserve all existing functionality.
7. Then implement incrementally by milestone.

The existing application already includes or is expected to include:

- Lead sourcing
- Lead enrichment
- Campaigns
- Locked call packets
- Admin, manager, and caller roles
- Caller login
- Call notes
- Call outcomes
- Decision-maker information
- Scripts
- Products/offers
- Call recordings and transcripts
- Conversation intelligence
- Caller grading
- GoHighLevel integration
- An admin action board
- A simplified caller workspace

The new systems must connect to all of these.

==================================================
CORE OBJECTIVE
==================================================

The platform must remember every meaningful action, result, and context surrounding sales activity.

It must then analyze those results and gradually improve:

- Which caller receives which leads
- Which caller works on which product
- Which industries should be called at which times
- Which scripts should be used
- Which objection response should appear
- Which leads should be prioritized
- Which callbacks should happen and when
- Which callers need coaching
- Which callers should be promoted, reassigned, placed on probation, or considered for termination
- How campaigns and packets should be constructed

The platform should become more effective as more calls, notes, outcomes, appointments, and sales are recorded.

Do not build a vague “AI analytics” layer.

Build a traceable system where every recommendation is backed by stored evidence, sample size, confidence, and measurable outcomes.

==================================================
SYSTEM 1: ORGANIZATIONAL MEMORY
==================================================

The Organizational Memory system must permanently preserve useful operational knowledge.

It should answer:

- What happened?
- Who did it?
- When did it happen?
- What lead, campaign, product, script, and caller were involved?
- What changed?
- What was the outcome?
- What was learned?
- Was that information later verified?
- Did an admin accept or reject the resulting recommendation?

Nothing important should be silently overwritten.

Use append-only events or an event-history model for critical activities, while still maintaining current-state tables for fast application use.

==================================================
EVENT MEMORY
==================================================

Create a normalized event system.

Every meaningful action should create an event.

Possible event types include:

- lead_created
- lead_imported
- lead_enriched
- lead_scored
- lead_assigned
- lead_reassigned
- lead_added_to_campaign
- lead_added_to_packet
- packet_created
- packet_assigned
- packet_started
- packet_paused
- packet_completed
- packet_abandoned
- call_started
- call_connected
- call_ended
- call_outcome_recorded
- note_added
- note_edited
- decision_maker_found
- direct_phone_found
- email_found
- callback_scheduled
- callback_completed
- objection_detected
- objection_response_used
- script_used
- script_changed
- product_offered
- product_changed
- appointment_booked
- appointment_confirmed
- appointment_attended
- appointment_missed
- sale_created
- sale_cancelled
- refund_created
- user_created
- user_disabled
- caller_coached
- caller_reassigned
- recommendation_generated
- recommendation_approved
- recommendation_rejected
- recommendation_implemented
- routing_rule_changed
- scoring_rule_changed
- experiment_started
- experiment_completed

Each event should store:

- event_id
- event_type
- occurred_at
- created_at
- performed_by_user_id
- caller_id if applicable
- lead_id if applicable
- business_id if applicable
- campaign_id if applicable
- packet_id if applicable
- project_id if applicable
- product_id if applicable
- script_id if applicable
- script_version_id if applicable
- objection_id if applicable
- call_id if applicable
- appointment_id if applicable
- sale_id if applicable
- source
- previous_value
- new_value
- metadata JSON
- confidence
- verification_status
- correlation_id
- causation_event_id

Use correlation IDs to connect related events from the same call, packet, workflow, or automation.

==================================================
CURRENT STATE + HISTORY
==================================================

Maintain both:

1. Current-state records for application speed
2. Historical records for analysis and auditability

Example:

The lead table may show the current decision-maker.

The event history should still preserve:

- The original unknown state
- When the name was discovered
- Who discovered it
- The source
- Whether it was corrected later
- The previous name
- The new name

Do not overwrite history when a note, phone number, title, script, or status changes.

==================================================
CALL MEMORY
==================================================

For every call, store:

- caller
- lead
- business
- campaign
- packet
- project
- product offered
- script version used
- opening variation
- call start time
- call end time
- duration
- business local time
- caller local time
- day of week
- industry
- city
- state
- region
- business size signals
- owner found before call
- decision-maker title
- phone type
- call attempt number
- prior outcome
- transcript
- recording URL
- automatic summary
- caller notes
- detected objections
- responses used
- stages reached
- sentiment if available
- talk/listen ratio
- interruptions
- silence periods
- questions asked
- booking attempt
- final outcome
- callback date
- appointment status
- eventual sale status
- revenue if known

Store raw data and derived metrics separately.

Do not permanently replace raw caller notes with AI summaries.

Keep both.

==================================================
CALLER MEMORY
==================================================

Each caller must have a continuously updated performance profile.

Store:

- total tenure
- active status
- projects assigned
- products assigned
- industries worked
- regions worked
- total dials
- connected calls
- decision-maker conversations
- callbacks
- appointments
- attended appointments
- sales
- revenue
- refunds or cancellations
- average call duration
- talk/listen ratio
- objections encountered
- objections successfully handled
- script versions used
- coaching completed
- packet completion rate
- average time per lead
- note quality
- data-entry accuracy
- appointment validity
- attendance rate
- sale rate

The caller profile must also track contextual strengths and weaknesses.

Examples:

- Strong with plumbers
- Weak with electricians
- Strong between 8:00 AM and 11:00 AM
- Strong with AI receptionist offer
- Weak with callback-only offer
- Strong when owner name is known
- Weak through office-manager gatekeepers
- Strong at opening
- Weak at discovery
- Strong at objection handling
- Weak at asking for the appointment

Every strength or weakness must include:

- metric
- comparison baseline
- sample size
- confidence level
- date range
- evidence
- last updated date

Never store an unsupported label such as:

“Caller A is bad at HVAC.”

Store something more precise:

“Caller A booked 1 appointment from 42 HVAC decision-maker conversations over the last 45 days, compared with a team rate of 8.4%. Confidence: medium.”

==================================================
PRODUCT AND PROJECT MEMORY
==================================================

The company will sell multiple products and bundles.

Examples:

- AI receptionist
- Missed-call callback system
- AI receptionist plus callback bundle
- Full front-desk bundle
- Appointment follow-up system
- Lead reactivation
- Future products

Create separate concepts for:

- Product
- Product version
- Offer
- Bundle
- Project
- Campaign

A Product is what is being sold.

An Offer defines positioning, pricing, guarantee, and packaging.

A Bundle may contain multiple products.

A Project groups a team and operational goal around one offer or product.

A Campaign contains leads being worked.

Example:

Project 1:
AI Receptionist

Assigned callers initially:
A, B, C

Project 2:
Callback System

Assigned callers initially:
D, E, F

The platform must track performance separately by:

- product
- offer
- bundle
- project
- campaign
- caller
- industry
- script
- time period

Do not combine results from different products into one generic appointment rate.

==================================================
SCRIPT MEMORY
==================================================

Every script must be versioned.

Create:

- script
- script_version
- script_section
- script_variant
- objection_response
- objection_response_version

Script sections may include:

- opening
- permission statement
- discovery
- problem framing
- product explanation
- proof
- pricing
- objection handling
- close
- appointment ask
- callback language

Whenever wording changes, create a new version.

Never overwrite an old script version.

For each script version, track:

- times used
- callers using it
- industries used on
- products used for
- decision-maker conversations
- objections
- appointments
- attended appointments
- sales
- revenue
- conversion rates
- date range
- confidence

The platform must be able to compare:

- Script v1 vs v2
- Different openings
- Different discovery questions
- Different objection responses
- Different closing language
- Performance by caller
- Performance by industry
- Performance by product
- Performance by time of day

==================================================
OBJECTION MEMORY
==================================================

Create structured objection categories.

Examples:

- not_interested
- already_have_receptionist
- already_have_software
- too_expensive
- send_information
- call_back_later
- too_busy
- need_partner_approval
- current_system_works
- do_not_trust_ai
- no_need
- bad_timing
- under_contract
- generic_rejection
- other

For each objection occurrence, store:

- objection category
- exact transcript excerpt
- call stage
- caller
- product
- script version
- response used
- whether conversation continued
- whether callback was obtained
- whether appointment was booked
- whether sale eventually occurred
- confidence
- manually corrected category if applicable

The platform should compare objection responses by context.

Example:

For “already have a receptionist”:

- Response A worked 4% of the time
- Response B worked 12% of the time
- Response B performed best with plumbing companies
- Response C performed best when speaking to office managers

==================================================
TIME AND CONTEXT MEMORY
==================================================

The platform must preserve enough contextual data to detect small operational patterns.

Track:

- exact timestamp
- lead local time
- caller local time
- hour block
- day of week
- week of month
- month
- season
- timezone
- industry
- region
- state
- city
- product
- script
- caller
- lead source
- business size
- rating
- review count
- decision-maker title
- owner identified before call
- phone type
- attempt number
- days since prior attempt

The analytics should be able to identify patterns such as:

- Plumbers produce more decision-maker conversations in the morning
- Electricians respond better around lunch
- One region performs better after 4:00 PM
- A certain caller performs better early in the shift
- A script performs better on second attempts
- Callback offers perform better with office managers
- AI receptionist bundles perform better with owners
- A certain objection appears more frequently at certain times
- A lead source connects well but rarely creates sales
- A caller books appointments but those appointments fail to attend
- A caller performs well at discovery but poorly at closing

==================================================
SYSTEM 2: ANALYTICS
==================================================

Build analytics in layers.

Do not jump immediately to autonomous optimization.

Layer 1:
Descriptive analytics

Layer 2:
Diagnostic analytics

Layer 3:
Recommendations

Layer 4:
Controlled experiments

Layer 5:
Admin-approved adaptive routing

Layer 6:
Limited automatic optimization

==================================================
DESCRIPTIVE ANALYTICS
==================================================

Provide dashboards and reports for:

- Total dials
- Connection rate
- Decision-maker conversation rate
- Decision-maker conversations per 100 dials
- Callback rate
- Appointment rate
- Appointment attendance rate
- Sale rate
- Revenue per dial
- Revenue per connected call
- Revenue per decision-maker conversation
- Revenue per appointment
- Refund and cancellation rate
- Average time per lead
- Packet completion rate
- Lead exhaustion rate
- Note completion rate
- Data quality rate

Allow breakdowns by:

- caller
- project
- product
- offer
- bundle
- campaign
- packet
- industry
- location
- timezone
- hour
- day
- script
- script version
- objection
- objection response
- lead source
- decision-maker title
- phone type
- owner-found status

==================================================
DIAGNOSTIC ANALYTICS
==================================================

The platform should explain why results may differ.

Examples:

- Caller A has a strong appointment rate but receives higher-quality leads
- Caller B reaches more decision-makers but fails to ask for appointments
- Script v3 increased callbacks but lowered attended appointments
- Plumbing leads answer more in the morning
- Electrician leads answer more midday
- Campaign X has poor results due to bad phone data
- Caller C appears weak overall but performs strongly on callback offers
- Caller D books many appointments, but those appointments are poorly qualified

Show the underlying evidence and avoid unsupported causal claims.

Use language such as:

“Associated with”
“Correlated with”
“Observed pattern”
“Insufficient evidence”
“Likely contributing factor”

Do not claim causation from observational data unless supported by a controlled experiment.

==================================================
SMALL-PATTERN ANALYSIS
==================================================

The system must examine both large patterns and small interactions.

Examples:

- caller × product
- caller × industry
- caller × time
- caller × objection
- caller × decision-maker title
- caller × script version
- product × industry
- product × time
- product × decision-maker title
- script × objection
- industry × time
- region × time
- lead source × product
- lead source × caller
- attempt number × callback delay
- owner-found status × appointment rate
- phone type × decision-maker rate

Support three-way interactions where sample size permits.

Examples:

- caller × industry × product
- caller × product × time
- script × objection × industry
- lead source × caller × product
- industry × time × decision-maker title

Do not surface tiny patterns without enough evidence.

==================================================
SAMPLE SIZE AND CONFIDENCE
==================================================

Every recommendation and detected pattern must include:

- sample size
- date range
- comparison group
- confidence
- estimated effect
- practical importance
- possible confounders

Use configurable minimum sample sizes.

Suggested defaults:

- Fewer than 10 relevant conversations:
  insufficient data

- 10–29:
  very low confidence

- 30–74:
  low confidence

- 75–149:
  medium confidence

- 150+:
  higher confidence

These thresholds should be configurable and should depend on the metric.

Do not use dial count alone when evaluating objection handling.

Use the number of actual objection occurrences or decision-maker conversations.

==================================================
PERFORMANCE BASELINES
==================================================

Compare performance against relevant baselines.

Examples:

- Caller vs team average
- Caller vs other callers on the same product
- Caller vs other callers on the same industry
- Script vs prior script version
- Campaign vs similar campaigns
- Time window vs same industry at other times
- Product vs other products with the same lead type

Avoid unfair comparisons.

Do not compare a caller assigned enriched owner leads against a caller assigned raw business numbers without controlling for lead quality.

==================================================
OUTCOME HIERARCHY
==================================================

Support configurable outcome weights.

Example default hierarchy:

- wrong number: -3
- do not call: -3
- no answer: 0
- voicemail: 0
- gatekeeper reached: 1
- decision-maker identified: 2
- decision-maker conversation: 4
- qualified callback: 5
- appointment booked: 10
- appointment confirmed: 12
- appointment attended: 15
- sale: 30
- retained sale: 40
- cancellation: -15
- refund: -20

Store the raw outcomes separately from weighted scores.

Do not rely only on the weighted score.

Primary optimization goals should be configurable:

- appointments
- attended appointments
- sales
- revenue
- retained revenue
- profit

Eventually optimize toward revenue and retained revenue, not vanity metrics.

==================================================
RECOMMENDATION ENGINE
==================================================

Generate recommendations for:

- Caller assignments
- Project assignments
- Product assignments
- Campaign assignments
- Packet composition
- Calling windows
- Script versions
- Objection responses
- Coaching
- Probation
- Reassignment
- Promotion
- Packet-size changes
- Lead-quality changes

Example recommendation:

“Assign Caller A more plumbing leads for the AI receptionist project between 8:00 AM and 11:00 AM.”

Include:

- recommendation type
- recommended action
- reason
- supporting metrics
- sample size
- confidence
- estimated upside
- risk
- expiration date
- review date
- admin status

Possible statuses:

- generated
- awaiting_review
- approved
- rejected
- implemented
- expired
- rolled_back

==================================================
CALLER EMPLOYMENT RECOMMENDATIONS
==================================================

The platform may recommend:

- Continue
- Coach
- Retrain
- Reduce packet size
- Move to another product
- Move to another industry
- Move to callbacks
- Place on probation
- Consider termination
- Increase responsibility
- Promote to stronger campaigns

However:

- Do not automatically terminate or disable anyone
- Do not make employment decisions from one metric
- Require minimum sample sizes
- Show supporting evidence
- Consider lead quality, tenure, project, and coaching history
- Require admin approval
- Preserve the recommendation and final admin decision

Example:

“Caller N is 31% below the relevant team baseline on decision-maker conversion and appointment rate across 412 comparable calls. The largest weakness is objection handling. Recommend a 7-day probation with targeted coaching before reassessment.”

==================================================
PACKET BUILDER OPTIMIZATION
==================================================

The analytics system must send recommendations to the packet builder.

The packet builder should eventually consider:

- caller
- product
- project
- industry
- location
- timezone
- calling window
- script version
- owner-found status
- decision-maker title
- lead score
- prior attempts
- callback status
- objection history
- caller strengths
- caller weaknesses
- campaign priority
- experimental allocation

Example optimized packet:

Caller A
Project: AI Receptionist
Product: AI Receptionist
Industry: Plumbing
Local call window: 8:00 AM–11:00 AM
Owner found: Yes
Script: Plumbing AI Receptionist v3
Packet size: 200

Example:

Caller D
Project: Callback System
Product: Missed-Call Callback
Industry: Electricians
Local call window: 12:00 PM–3:00 PM
Owner found: Optional
Script: Callback Offer v2
Packet size: 100

Initially, the system should only recommend packet configurations.

An admin approves and generates the packet.

Later, support limited automatic packet generation.

==================================================
EXPLORATION VS EXPLOITATION
==================================================

Do not route 100% of leads based on current winners.

Support configurable exploration.

Example:

- 80% optimized assignments
- 20% controlled testing

The system needs to continue testing:

- new callers
- new scripts
- new products
- new industries
- new calling times
- alternative objection responses

Without exploration, the platform will lock into early assumptions and fail to discover better combinations.

Create experiment groups and control groups.

==================================================
EXPERIMENT SYSTEM
==================================================

Build controlled experiments for:

- Script A vs Script B
- Morning vs afternoon calling
- Owner-found vs non-enriched leads
- Product A vs Product B
- Objection response A vs B
- Packet size 100 vs 200
- Named decision-maker opening vs role-based opening

Each experiment should include:

- hypothesis
- primary metric
- secondary metrics
- target population
- control group
- treatment group
- start date
- planned sample size
- stop conditions
- result
- confidence
- admin conclusion

Avoid changing multiple variables in one simple experiment unless intentionally using a multivariate design.

==================================================
LEARNING FROM ADMIN DECISIONS
==================================================

Store:

- recommendation
- admin approval or rejection
- admin reason
- implementation date
- measured result
- rollback decision

The system should learn whether its own recommendations were useful.

Track:

- recommendation acceptance rate
- recommendation success rate
- estimated improvement
- actual improvement
- false-positive rate
- rollback rate

==================================================
REAL-TIME CALLER GUIDANCE
==================================================

Send useful findings to the caller workspace.

Examples:

- Best person to ask for
- Recommended script
- Product to offer
- Current call goal
- Suggested discovery question
- Objection response
- Callback instructions
- Relevant prior notes
- Best time to retry

Keep live guidance short.

Do not overload the caller with analytics.

Display one or two actionable recommendations at a time.

==================================================
ADMIN DASHBOARD
==================================================

Create admin views for:

1. Organizational overview
2. Project performance
3. Product performance
4. Caller profiles
5. Campaign performance
6. Packet performance
7. Script laboratory
8. Objection analytics
9. Time-of-day analytics
10. Lead-source analytics
11. Recommendation queue
12. Experiment results
13. Data quality
14. Audit history

Caller profile view should show:

- overall metrics
- product metrics
- industry metrics
- time metrics
- objection metrics
- script metrics
- trend over time
- strengths
- weaknesses
- current recommendations
- coaching history
- probation history
- project assignments
- sample sizes and confidence

==================================================
DATA QUALITY
==================================================

Build checks for:

- Missing call outcomes
- Missing notes
- Fake or invalid appointments
- Duplicate calls
- Impossible call durations
- Incorrect callback dates
- Caller inactivity
- Excessive one-click dispositions
- Appointment classifications that do not match transcript
- Decision-maker claims that conflict with transcript
- Incorrect product classification
- Missing script version

Flag questionable records for admin review.

Do not silently train optimization logic on low-quality records.

Each data point should have a quality score.

Allow analytics to exclude low-quality data.

==================================================
DATABASE DESIGN
==================================================

Add or update models for:

- events
- caller_profiles
- caller_skill_metrics
- caller_context_metrics
- products
- product_versions
- offers
- bundles
- projects
- project_assignments
- scripts
- script_versions
- script_sections
- objections
- objection_occurrences
- objection_responses
- calls
- call_stage_events
- recommendations
- recommendation_evidence
- experiments
- experiment_assignments
- experiment_results
- optimization_rules
- routing_decisions
- packet_recommendations
- coaching_actions
- performance_snapshots
- data_quality_flags
- admin_decisions

Use materialized views or summary tables where appropriate for dashboard speed.

Do not calculate every historical metric from raw transcripts on every page load.

==================================================
ANALYTICS JOBS
==================================================

Use background jobs for:

- Recalculating caller profiles
- Recalculating script metrics
- Recalculating objection metrics
- Detecting patterns
- Generating recommendations
- Updating confidence scores
- Creating daily performance snapshots
- Detecting data-quality problems
- Evaluating experiments
- Measuring implemented recommendations

Support:

- Incremental updates after new calls
- Scheduled deeper analysis
- Manual admin-triggered recalculation

==================================================
API ENDPOINTS
==================================================

Create endpoints for:

- Record event
- Read event history
- View caller profile
- View product analytics
- View project analytics
- View script analytics
- View objection analytics
- View time analytics
- View campaign analytics
- View packet analytics
- List recommendations
- Approve recommendation
- Reject recommendation
- Implement recommendation
- Roll back recommendation
- Create experiment
- Start experiment
- Stop experiment
- View experiment result
- View packet recommendation
- Generate packet from approved recommendation
- Add coaching action
- Review data-quality flags
- Recalculate analytics

==================================================
ACCESS CONTROL
==================================================

Admin:

- Full analytics
- Full recommendation access
- Approve or reject changes
- View all callers
- View audit history
- Manage experiments

Manager:

- View assigned team
- View recommendations for assigned team
- Assign coaching
- Generate approved packets
- No access to system-wide settings unless authorized

Caller:

- View personal metrics
- View assigned project
- View assigned product
- View coaching
- View limited personal recommendations
- No access to other callers’ detailed performance
- No access to employment recommendations
- No access to sensitive admin analytics

==================================================
IMPLEMENTATION STAGES
==================================================

Milestone 1: Memory foundation

- Event system
- Audit history
- Current-state plus historical records
- Call context storage
- Product/project/script versioning
- Raw and derived data separation
- Database migrations
- Tests

Milestone 2: Descriptive analytics

- Caller metrics
- Product metrics
- Project metrics
- Campaign metrics
- Packet metrics
- Time metrics
- Script metrics
- Objection metrics
- Admin dashboards

Milestone 3: Caller profiles

- Contextual strengths and weaknesses
- Sample sizes
- Confidence
- Relevant baselines
- Trend tracking
- Coaching history

Milestone 4: Recommendation engine

- Recommendations
- Evidence
- Admin approval
- Rejection
- Implementation tracking
- Packet-builder recommendations
- Project and product reassignment recommendations

Milestone 5: Experiment system

- Control and treatment groups
- Script tests
- Timing tests
- Product tests
- Routing tests
- Experiment reporting

Milestone 6: Adaptive routing

- Exploration percentage
- Optimized packet suggestions
- Caller-product matching
- Caller-industry matching
- Calling-window matching
- Script matching
- Objection-response matching
- Admin-approved automatic routing

Milestone 7: Self-evaluation

- Compare estimated impact against actual impact
- Recommendation success tracking
- Rollback logic
- Recommendation quality metrics
- Controlled expansion of automation

At the end of every milestone:

1. Run tests.
2. Fix errors.
3. Document database changes.
4. Show completed functionality.
5. Explain how to test it.
6. List known limitations.
7. Do not proceed while core tests are failing.

==================================================
IMPORTANT RULES
==================================================

1. Store raw evidence before generating conclusions.
2. Never overwrite historical facts.
3. Every recommendation must be explainable.
4. Every recommendation must show sample size and confidence.
5. Do not optimize from tiny samples.
6. Separate products, projects, scripts, industries, and callers.
7. Do not judge callers only by appointments.
8. Track attended appointments, sales, revenue, cancellations, and refunds.
9. Control for lead quality where possible.
10. Distinguish correlation from causation.
11. Require admin approval before major operational or employment changes.
12. Preserve manual override.
13. Continue controlled exploration.
14. Make all optimization reversible.
15. Exclude questionable data from learning until reviewed.
16. The system should become smarter without becoming a black box.

Start by reviewing the existing repository and producing:

1. A current architecture summary
2. A gap analysis
3. A proposed database schema
4. A migration plan
5. A milestone implementation plan
6. Risks and safeguards

Then begin Milestone 1 only.

Choose Lean Milestone 1 now.

Build the memory foundation around features and actions that already exist in the application.

Implement:

1. A centralized events table
2. Event-writing service/helper
3. Audit history
4. Current-state plus historical records
5. Correlation IDs for related actions
6. Metadata support for flexible context
7. Integration into real workflows on both applications

Wire events into:

- Lead creation/import
- Lead enrichment started/completed/failed
- Decision-maker discovery
- Contact information changes
- Lead status changes
- Campaign lifecycle
- Packet creation
- Packet assignment
- Packet start/pause/resume/completion
- Lead assignment and locking
- Call started
- Call completed
- Call outcome recorded
- Notes added or edited
- Callback information recorded
- Caller/user creation
- Caller role changes
- Caller project assignment
- Caller account disabling
- Lead reassignment
- Relevant admin actions

Do not build speculative tables for features that do not exist yet, including:

- Scripts
- Structured objections
- Appointments
- Sales
- Revenue
- Experiments
- Recommendations
- Adaptive routing

However, design the events table and event service so those future event types can be added without rebuilding the foundation.

Use flexible fields such as:

- event_type
- entity_type
- entity_id
- actor_user_id
- caller_id
- business_id
- campaign_id
- packet_id
- call_id
- project_id
- occurred_at
- previous_value JSON
- new_value JSON
- metadata JSON
- correlation_id
- causation_event_id
- source
- confidence
- verification_status

Do not force every possible future feature into dedicated foreign keys immediately. Use entity_type/entity_id and metadata where appropriate, while keeping real existing relationships strongly typed.

Also create:

- Event indexes
- Event querying/filtering
- Admin event history view
- Per-lead history
- Per-packet history
- Per-caller history
- Per-call history
- Tests proving events are created from actual workflows
- Database migrations
- Backfill strategy for existing records where possible

Important:

Milestone 1 is not complete merely because an events table exists.

It is complete only when actual actions in both applications automatically create accurate events and those events can be viewed and queried.

Before coding:

1. Inspect both applications.
2. List every existing real workflow that should emit an event.
3. Show the proposed schema.
4. Show where event-writing will be inserted.
5. Identify duplicate or conflicting event systems already present.
6. Then implement incrementally.

Do not build empty future-feature tables just to match the original specification. We will add those tables when their corresponding features are designed and implemented.
```

### The complete memory, analytics, experimentation and optimization system

*The longest one. Built on top of the plan the previous prompt produced.*

```
Build the Complete Memory, Analytics, Experimentation, and Optimization System
Work directly inside the existing production applications and database.
This is not a planning task. Inspect the current codebase, database schema, migrations, API routes, server actions, caller dialer, admin board, packet workflows, enrichment workflows, appointment records, and existing metrics pages, then implement the complete system described below.
Do not replace working systems unnecessarily. Extend the existing architecture cleanly.
The applications use:

* Next.js App Router
* Supabase/Postgres
* Vercel
* Existing admin/dispatch board
* Existing caller-facing dialer
* Existing lead, campaign, packet, enrichment, caller, call, appointment, and sourcing workflows

The system must remain practical for a small internal cold-calling operation. Do not turn this into an overengineered public SaaS product.
Core objective
Build a system that:

1. Permanently remembers everything important that happens
2. Preserves raw evidence and historical changes
3. Measures caller, lead, enrichment, script, offer, product, timing, and campaign performance
4. Detects both broad patterns and small interactions
5. Avoids drawing conclusions from weak sample sizes
6. Creates evidence-backed recommendations
7. Sends those recommendations back into caller assignments, call packets, scripts, objection responses, retry timing, and daily files
8. Tracks whether recommendations were followed
9. Measures whether the recommended change actually improved performance
10. Learns continuously as more calls, appointments, sales, and outcomes are recorded

The system must ultimately optimize toward:

* More decision-maker conversations per 100 dials
* More qualified appointments per 100 dials
* Better appointment attendance
* More sales
* More retained revenue
* Lower enrichment cost per useful result
* Lower wasted caller time
* Better lead-to-caller matching
* Better calling times
* Better scripts and objection responses
* Better product and offer selection

Do not optimize only for appointment volume. The final business outcome matters.
1. Activate and verify the existing event-memory system
First inspect the existing migration:
`supabase/migrations/0012_event_memory.sql`
Confirm that the corrected migration from commit `eeed4ab` is present.
Run or prepare the migration correctly for the active Supabase project.
Do not assume the migration worked merely because the file exists.
Verify that:

* The `events` table exists
* Events are append-only
* UPDATE and DELETE attempts are rejected
* Existing event-emitting workflows successfully insert records
* Correlation IDs group related events
* Causation or parent event IDs connect caused events
* Before and after values are preserved
* Actor type and actor ID are recorded
* Source, confidence, verification status, entity type, and entity ID are recorded
* The History tab loads real records
* Lead-specific history loads inline
* Missing migrations produce an explicit warning instead of silently showing an empty feed

Perform a real workflow test after migration:

1. Create or select a test lead
2. Assign it to a packet
3. Log a call
4. Add a discovery
5. Change the lead stage
6. Schedule a callback
7. Book an appointment
8. Verify all resulting events exist
9. Verify they share the correct correlation and causation information
10. Verify the records appear in the UI

Do not proceed based only on TypeScript compilation.
2. Preserve all existing memory and evidence systems
Inspect and retain the existing behavior of:

* `events`
* `enrichment_evidence`
* `source_records`
* `call_discoveries`
* `contacts`
* `calls.details`
* Lead history
* Caller history
* Packet history
* Campaign history
* Appointment history
* Import and deduplication history

Every important entity must preserve:

* Original source
* Original raw value
* Current normalized value
* Previous value
* New value
* Who or what changed it
* When it changed
* Confidence
* Verification status
* Relevant evidence
* Correlation to the workflow that caused it

Do not delete conflicting claims simply because a newer claim exists.
Retain conflicting owner names, phone numbers, roles, emails, and other discoveries with evidence and confidence.
Caller-confirmed information should normally outrank scraped or inferred information, but the older evidence must remain accessible.
3. Add complete operational notes and action memory
Build permanent notes and action tracking for callers, virtual assistants, admins, workers, and automated processes.
Create appropriate tables such as:

* `entity_notes`
* `action_items`
* `action_item_events`
* `worker_activity`
* `admin_decisions`

Each note or action must support links to one or more of:

* Lead
* Contact
* Call
* Caller
* Worker
* Packet
* Campaign
* Appointment
* Opportunity
* Sale
* Script
* Product
* Offer
* Experiment
* Recommendation
* Enrichment workflow

Notes must store:

* Author
* Author type
* Body
* Note category
* Created time
* Updated time
* Visibility
* Pinned status
* Source
* Related entities
* Correlation ID

Actions must store:

* Title
* Description
* Creator
* Assignee
* Priority
* Status
* Due date
* Completion date
* Related entities
* Required result
* Completion notes
* Verification status
* Correlation ID

Every create, edit, assignment, status change, completion, reopening, or deletion-equivalent archival action must emit history events.
Do not hard-delete operational notes or actions.
4. Build proper call-session tracking
The current system must not record only the final outcome timestamp.
Create a proper call-session model.
At minimum, capture:

* `started_at`
* `dial_started_at`
* `ringing_at`
* `connected_at`
* `ended_at`
* `dispositioned_at`
* Ring duration
* Connected duration
* Total session duration
* Hold duration when available
* Call provider
* Provider call ID
* Caller
* Lead
* Contact dialed
* Phone number dialed
* Packet
* Campaign
* Attempt number
* Call direction
* Outcome
* `spoke_with_role`
* Whether a decision-maker was reached
* Whether the owner or decision-maker name was known before the call
* Whether enrichment was available before the call
* Whether a callback was created
* Whether an appointment was created
* Script version
* Product
* Offer
* Experiment assignment
* Browser/session fallback timing
* Provider timing verification status

Use provider timestamps where available.
A browser timer may be used as a fallback, but it must not silently replace authoritative provider timing.
Emit events for:

* Call started
* Dial initiated
* Call connected
* Call ended
* Outcome recorded
* Call details updated
* Callback created
* Appointment created
* Discovery recorded

Avoid duplicate events when provider webhooks and browser actions report the same state.
Use idempotency keys.
5. Capture structured call outcomes completely
Keep raw caller notes, but do not rely only on free text.
Every call outcome must support structured fields appropriate to that outcome, including:

* Person reached
* Role reached
* Owner reached
* Gatekeeper reached
* Wrong number
* Disconnected number
* No answer
* Voicemail
* Callback requested
* Not interested
* Interested
* Appointment booked
* Existing solution
* Decision-maker unavailable
* Main problem discovered
* Current answering setup
* Missed-call behavior
* After-hours behavior
* Scheduling method
* Lead volume
* Interest level
* Purchase timing
* Objections raised
* Next step
* Callback date and time
* Qualification status
* Caller confidence
* Raw notes

Preserve the exact details entered at the time of the call.
Do not overwrite historical call details when the lead record changes later.
6. Build scripts, script versions, and script usage tracking
Scripts must become first-class entities.
Create:

* `scripts`
* `script_versions`
* `script_sections`
* `call_script_usage`
* `script_performance_snapshots`

Each script must support:

* Name
* Purpose
* Product
* Offer
* Target industries
* Target caller types
* Status
* Owner
* Created time
* Archived time

Every script edit must create a new immutable version.
A call must store the exact `script_version_id` used.
Do not attach a call only to the current script record because that would corrupt historical attribution when the script changes.
Track:

* Script opened
* Script section viewed
* Script version assigned
* Script changed during a call
* Caller-reported adherence
* Call outcome after script usage

Seed the current implicit script as Version 1.
Do not require a complete advanced script editor before data can be captured. A simple admin management interface is acceptable initially, but versioning and attribution must work.
7. Build objection and objection-response tracking
The dialer currently displays objections and suggested responses. That usage must be recorded.
Create:

* `objections`
* `objection_response_versions`
* `call_objection_events`

For each objection interaction, record:

* Call
* Caller
* Lead
* Script version
* Product
* Offer
* Objection selected
* Response version displayed
* Timestamp opened
* Whether the caller marked it as used
* Whether the response was modified
* Caller notes
* Prospect reaction
* Whether the objection was overcome
* Conversation continuation status
* Final call outcome
* Appointment created
* Sale attribution later

Do not treat a button click as proof that the caller used the response.
The UI should allow the caller to quickly mark:

* Used
* Partially used
* Not used
* Overcame objection
* Did not overcome
* Prospect gave a different objection

Keep this lightweight enough that it does not slow callers excessively.
Every objection response edit must create a new immutable version.
Seed the nine existing objection responses into the database as Version 1 records.
8. Build products, offers, and bundles
Products and offers must become first-class entities.
Create:

* `products`
* `product_versions` when needed
* `offers`
* `offer_versions`
* `bundles`
* `bundle_items`
* `campaign_products`
* `call_product_usage`
* `appointment_product_interest`

Support products including:

* AI receptionist
* Missed-call callback or text-back
* Appointment booking
* Lead intake
* Bundles
* Future products

Each call must support attribution to:

* `product_id`
* `offer_version_id`
* `bundle_id` when applicable

Seed the current implicit product and offer as Version 1 defaults.
Offer records should support:

* Price
* Billing model
* Setup fee
* Trial
* Guarantee
* Included features
* Target market
* Active dates
* Status

Historical calls must remain linked to the exact offer version used at the time.
9. Build the appointment lifecycle
Do not use only a booked/not-booked field.
Create a complete appointment lifecycle.
Statuses must include:

* Scheduled
* Confirmation pending
* Confirmed
* Rescheduled
* Canceled by prospect
* Canceled internally
* Attended
* No-show
* Qualified
* Unqualified
* Proposal sent
* Closed won
* Closed lost

Store:

* Appointment creator
* Originating call
* Caller
* Lead
* Contact
* Campaign
* Packet
* Product
* Offer
* Script version
* Scheduled time
* Confirmation time
* Attendance result
* Actual start time
* Actual end time
* Qualification result
* No-show reason
* Cancellation reason
* Reschedule history
* Notes
* Correlation ID

Every lifecycle change must emit an event.
Provide a fast admin toggle or workflow for recording attendance and qualification.
Appointment performance must be attributed back to:

* Caller
* Call
* Campaign
* Script
* Offer
* Product
* Lead source
* Enrichment state
* Calling time
* Objections encountered

10. Build opportunities, sales, revenue, cancellations, and refunds
Create the schema and minimum working workflow now, even if there are currently few or no sales.
Create:

* `opportunities`
* `opportunity_stage_events`
* `sales`
* `sale_items`
* `payments`
* `subscriptions`
* `cancellations`
* `refunds`
* `revenue_events`

Maintain the complete attribution chain:
Lead
→ Call
→ Appointment
→ Opportunity
→ Sale
→ Payment
→ Subscription
→ Cancellation or refund
Sales must store:

* Product
* Offer version
* Sale amount
* Setup fee
* Recurring amount
* Billing frequency
* Close date
* Closer
* Originating caller
* Originating call
* Appointment
* Campaign
* Script version
* Lead source
* Enrichment state
* Status

Revenue analysis must distinguish:

* Booked revenue
* Collected revenue
* Recurring revenue
* Refunded revenue
* Canceled revenue
* Retained revenue
* Net revenue

Do not calculate revenue-per-dial from uncollected contracts as though it were cash.
The initial interface may be minimal, but the data model and attribution must be production-ready before selling volume increases.
11. Build data-quality scoring
Create a data-quality layer for leads, contacts, and enrichment.
Track:

* Required-field completeness
* Phone validity
* Website validity
* Address consistency
* Duplicate likelihood
* Conflicting owner claims
* Stale evidence
* Source reliability
* Caller verification
* Enrichment confidence
* Contact confidence
* Decision-maker confidence
* Last verified date
* Missing key fields
* Invalid or suppressed data

Create:

* `data_quality_scores`
* `data_quality_issues`
* `source_reliability_stats`

Calculate quality scores without destroying the raw evidence.
Allow the score explanation to show:

* Why the score is high or low
* Which fields are missing
* Which sources conflict
* What action could improve the score

Measure whether high-quality data actually creates better calling outcomes.
12. Build the analytics engine
Do not stop at descriptive totals.
Create a reusable analytics layer using SQL views, database functions, materialized views where justified, and typed server-side query services.
The engine must analyze at minimum:
Overall funnel

* Leads sourced
* Leads qualified
* Leads enriched
* Leads packeted
* Dials
* Connections
* Gatekeeper conversations
* Decision-maker conversations
* Qualified conversations
* Callbacks
* Appointments
* Confirmed appointments
* Attended appointments
* Qualified appointments
* Sales
* Collected revenue
* Refunds
* Retained revenue

Core rates

* Connect rate
* Decision-maker conversations per 100 dials
* Qualified conversations per 100 dials
* Callbacks per 100 dials
* Appointments per 100 dials
* Attended appointments per 100 dials
* Qualified appointments per 100 dials
* Sales per 100 dials
* Revenue per dial
* Collected revenue per dial
* Retained revenue per dial
* No-show rate
* Close rate
* Refund rate

Required analysis dimensions
Analyze results by:

* Caller
* Industry
* City
* State
* Region
* Hour of day
* Day of week
* Date range
* Campaign
* Packet
* Lead source
* Search query or sourcing combination
* Rating range
* Review-count range
* Attempt number
* Owner name known before call
* Decision-maker known before call
* Enrichment level
* Enrichment confidence
* Data-quality score
* Script version
* Script section
* Objection
* Objection-response version
* Product
* Offer version
* Bundle
* Appointment status
* Closer
* Experiment variant

Required interaction analysis
Support combinations such as:

* Caller × industry
* Caller × hour
* Caller × day
* Caller × industry × hour
* Industry × hour
* Industry × day
* City × industry
* Script × caller
* Script × industry
* Objection × response version
* Objection × caller
* Product × industry
* Offer × industry
* Enrichment × industry
* Owner-known × caller
* Attempt number × industry
* Review count × industry
* Data quality × outcome

The system must look for small interactions, not only large overall averages.
Example:
“Caller A performs strongly with plumbers between 8:00 and 10:00 a.m., while Caller B performs better with electricians after 3:00 p.m.”
However, small-pattern analysis must never ignore sample size or uncertainty.
13. Add baselines, sample-size controls, and confidence gating
The analytics system must not generate confident-sounding garbage from tiny samples.
Create configurable analysis rules including:

* Minimum dial count
* Minimum connected-call count
* Minimum decision-maker conversation count
* Minimum appointment count
* Minimum sale count
* Confidence threshold
* Minimum effect size
* Minimum comparison-group size
* Recency window
* Long-term window
* Decay weighting
* Outlier handling

Every insight must include:

* Sample size
* Comparison baseline
* Observed difference
* Confidence level
* Data range
* Whether the pattern is exploratory or actionable
* Primary metric
* Supporting metrics
* Known limitations

Use labels such as:

* Insufficient data
* Early signal
* Moderate evidence
* Strong evidence
* Confirmed operational pattern

Do not hide small patterns completely. Show them as early signals when useful, but do not allow them to automatically alter routing until they pass the configured threshold.
Compare callers fairly.
Do not compare a caller handling difficult stale leads against a caller receiving fresh enriched leads without adjustment.
Where practical, account for:

* Lead source
* Lead quality
* Industry
* Attempt number
* Owner-known status
* Enrichment
* Time slot
* Campaign
* Offer

14. Build persistent caller strength and weakness profiles
Create caller performance profiles that update over time.
Each profile should show:

* Overall performance
* Recent performance
* Long-term performance
* Best industries
* Weakest industries
* Best calling windows
* Weakest calling windows
* Owner-conversation performance
* Gatekeeper performance
* Objection-handling performance
* Script compatibility
* Product compatibility
* Appointment attendance quality
* Sale quality
* Revenue quality
* Average call duration
* Data-entry completeness
* Coaching priorities
* Confidence and sample size for every conclusion

Separate:

* Volume
* Efficiency
* Appointment quality
* Sale quality
* Data quality
* Operational consistency

A caller should not be labeled strong merely because they log many callbacks.
15. Build lead, campaign, source, script, and product profiles
Create similar performance profiles for:

* Leads
* Lead sources
* Search combinations
* Industries
* Cities
* Campaigns
* Packets
* Scripts
* Objection responses
* Products
* Offers
* Bundles
* Enrichment methods

Examples of questions the system must eventually answer:

* Does finding the owner’s name increase decision-maker conversations?
* Does enrichment pay for itself?
* Which source produces the most attended appointments?
* Which script generates appointments that actually attend?
* Which offer produces the most retained revenue?
* At what attempt number does performance collapse?
* Which review-count ranges convert best?
* Which industries should be called in the morning?
* Which caller handles gatekeepers best?
* Which objection response produces the best downstream sales result?

16. Build an evidence-backed recommendation engine
Create:

* `recommendations`
* `recommendation_evidence`
* `recommendation_targets`
* `recommendation_actions`
* `recommendation_results`
* `recommendation_feedback`

Recommendations must support types such as:

* Caller assignment
* Industry routing
* Time-window routing
* Retry scheduling
* Packet ordering
* Lead prioritization
* Lead suppression
* Enrichment recommendation
* Script recommendation
* Objection-response recommendation
* Product recommendation
* Offer recommendation
* Coaching recommendation
* Experiment recommendation
* Data-quality action

Each recommendation must include:

* Plain-language recommendation
* Target entity or entities
* Evidence
* Metrics
* Baseline
* Sample size
* Confidence
* Expected impact
* Risk
* Creation time
* Expiration time
* Status
* Whether approval is required
* Who approved or rejected it
* Reason for rejection
* Implementation status
* Result after implementation

Statuses should include:

* Draft
* Insufficient data
* Proposed
* Approved
* Rejected
* Applied
* Monitoring
* Successful
* Neutral
* Harmful
* Expired
* Reverted

Do not create recommendations merely because one metric moved.
The recommendation engine must distinguish:

* Correlation
* Likely operational signal
* Tested causal improvement

17. Close the learning loop
The system must measure what happens after a recommendation.
Record:

* Whether the recommendation was viewed
* Whether it was approved
* Whether it was applied
* What exact configuration changed
* When it changed
* Which calls were affected
* What comparison group was used
* Whether the metric improved
* Whether another metric worsened
* Whether the change should remain, be revised, or be reverted

Do not allow the system to claim it “learned” simply because it generated a recommendation.
Learning requires:

1. Pattern detected
2. Recommendation created
3. Action applied
4. Results observed
5. Results compared
6. Recommendation marked successful, neutral, or harmful
7. Future routing or recommendations adjusted accordingly

18. Build experiments and A/B testing
Create:

* `experiments`
* `experiment_variants`
* `experiment_assignments`
* `experiment_metrics`
* `experiment_results`
* `experiment_events`

Support experiments for:

* Scripts
* Script openings
* Objection responses
* Products
* Offers
* Calling windows
* Caller routing
* Lead ordering
* Enrichment methods
* Retry cadence
* Packet composition

Each experiment must support:

* Hypothesis
* Primary metric
* Guardrail metrics
* Target population
* Inclusion rules
* Exclusion rules
* Variants
* Assignment method
* Start date
* End date
* Minimum sample
* Stopping rule
* Confidence requirement
* Status
* Result
* Recommendation

Prevent accidental contamination where the same lead receives conflicting variants without an explicit crossover design.
Do not declare winners prematurely.
Allow experiments to be:

* Draft
* Running
* Paused
* Completed
* Inconclusive
* Stopped for harm

19. Build adaptive routing and optimized daily files
The analytics must affect the work callers receive.
Create a routing and planning layer that can produce optimized daily call assignments.
Routing inputs should include:

* Caller strengths
* Industry
* Geographic region
* Time of day
* Day of week
* Attempt number
* Lead freshness
* Lead quality
* Owner-name availability
* Enrichment state
* Script
* Product
* Offer
* Previous call outcomes
* Callback commitments
* Experiment assignments
* Recommendation confidence
* Caller workload
* Time zone

The system should be able to recommend or apply:

* Plumbers in the morning
* Electricians midday
* Another category later
* Specific callers for specific industries
* Specific scripts for specific groups
* Specific objection responses for specific callers
* Better retry windows
* Higher-priority leads first
* Enriched leads to the callers most likely to use that information well
* Existing callbacks before new cold dials
* Suppression of leads with low expected value

Create:

* `routing_rules`
* `routing_decisions`
* `daily_call_plans`
* `daily_call_plan_items`
* `packet_optimization_runs`

Every routing decision must preserve:

* Inputs
* Rule or recommendation used
* Score
* Confidence
* Alternative options
* Final assignment
* Whether a human overrode it
* Override reason
* Result

Start in recommendation or approval mode.
Do not silently enable fully automatic routing until enough data exists and the feature is explicitly enabled.
20. Relay findings to callers and operational files
The system must not hide analytics only inside an admin dashboard.
Caller-facing packets and dialer screens should receive relevant guidance, including:

* Recommended script version
* Recommended opening
* Known decision-maker
* Relevant discoveries
* Best callback time
* Most likely objection
* Suggested objection response
* Product or offer being tested
* Experiment assignment
* Lead-specific notes
* Clear next action

Do not overwhelm callers with the entire analytics engine.
Show only the information useful for the current call.
Admin users should be able to see why the recommendation was made.
Generated daily files or packets must preserve the optimization metadata so the result of the routing decision can later be measured.
21. Build the analytics and management interfaces
Extend the existing UI with practical pages or tabs.
At minimum provide:
Metrics dashboard

* Overall funnel
* Rate metrics
* Date filters
* Campaign filters
* Caller filters
* Industry filters
* Product filters
* Script filters
* Source filters
* Appointment and revenue outcomes

Caller profiles

* Strengths
* Weaknesses
* Trends
* Sample sizes
* Coaching
* Best assignments

Pattern explorer
Allow admins to select dimensions and metrics, such as:

* Caller
* Industry
* Hour
* Day
* Script
* Objection
* Product
* Offer
* Enrichment
* Source
* Review range
* Attempt number

Show sample size and confidence beside every result.
Recommendations

* Proposed recommendations
* Evidence
* Confidence
* Approve
* Reject
* Apply
* Revert
* Result tracking

Experiments

* Create experiment
* Assign variants
* View progress
* View sample size
* Stop or complete
* View outcome

Scripts and objections

* Manage scripts
* Create immutable versions
* Manage objection responses
* View performance

Products and offers

* Manage products
* Manage bundles
* Manage offer versions
* View downstream performance

Appointment and sales outcomes

* Attendance
* Qualification
* Sale
* Revenue
* Refund
* Retention

Data quality

* Missing information
* Conflicts
* Stale information
* Low-confidence enrichment
* Recommended cleanup

Keep the existing charcoal and amber visual design consistent.
22. Improve “What to Attack Today”
The existing Claude-generated daily priority feature must use real structured analytics and recommendations.
It should consider:

* Pipeline state
* Callback obligations
* Appointment follow-up
* Caller availability
* Lead freshness
* Industry timing patterns
* Campaign performance
* Enrichment backlog
* Data-quality issues
* Experiments
* Recommendations waiting for approval
* Underperforming callers
* Strong early opportunities

It must not invent features or tell users to perform work that the system already automates.
Every suggestion should link to the underlying records and evidence.
Where there is insufficient data, say so.
23. Event coverage requirements
Every meaningful create, update, assignment, lifecycle transition, recommendation, experiment, routing decision, and result must emit events.
Add event coverage for:

* Notes
* Actions
* Call sessions
* Objection usage
* Script usage
* Script versions
* Products
* Offers
* Appointments
* Attendance
* Opportunities
* Sales
* Payments
* Refunds
* Experiments
* Variant assignments
* Recommendations
* Recommendation approvals
* Recommendation applications
* Routing decisions
* Overrides
* Data-quality score changes

Use one correlation ID for one logical workflow.
Do not create unrelated correlation IDs for every database row when all rows came from one user action.
Prevent duplicate events.
24. Backfill and historical compatibility
Create safe backfill scripts where possible.
Backfill existing records with:

* Default Product Version 1
* Default Offer Version 1
* Default Script Version 1
* Unknown or legacy values for fields that cannot be reconstructed

Never fabricate historical detail.
Use explicit values such as:

* `legacy_unknown`
* `not_captured`
* `unverified`

Do not pretend old calls had timing, objection, script, or attendance information that was never recorded.
All new columns must have safe defaults or nullable behavior so existing production data continues working.
25. Security, permissions, and integrity
Use row-level security appropriately.
Callers should not gain broad access to:

* Other callers’ private performance
* Revenue information
* Admin recommendations
* Sensitive worker notes
* Internal experiments unless relevant to their call

Admins should have appropriate management access.
Protect append-only records.
Use server-side authorization, not only hidden UI buttons.
Add indexes for common analytics filters.
Avoid N+1 queries.
Use database transactions for workflows that create multiple linked records.
Use idempotency for provider events and repeated submissions.
26. Performance requirements
Do not calculate every large analytics query from raw rows on every page load.
Use:

* Indexed queries
* SQL views
* Materialized views where beneficial
* Incremental aggregate tables where justified
* Scheduled refresh or event-triggered refresh strategies
* Cached server-side analytics with clear freshness timestamps

Always preserve the raw underlying records.
Show when analytics were last refreshed.
Do not allow cached analytics to overwrite source data.
27. Testing requirements
Add tests for:

* Append-only event protection
* Correlation grouping
* Call-session timing
* Duplicate webhook handling
* Script-version attribution
* Objection-response attribution
* Appointment lifecycle
* Attendance tracking
* Sale attribution
* Refund attribution
* Sample-size gating
* Confidence labels
* Recommendation generation
* Recommendation approval and rejection
* Routing overrides
* Experiment assignment
* Experiment contamination prevention
* Data-quality scoring
* Role-based access
* Historical backfill
* Existing workflow compatibility

Add at least one end-to-end test covering:
Lead created
→ Enrichment
→ Packet assignment
→ Call started
→ Objection used
→ Decision-maker reached
→ Appointment booked
→ Appointment attended
→ Sale recorded
→ Payment recorded
→ Recommendation analytics updated
28. Required implementation behavior
Do not respond with only a roadmap.
Implement the system.
Do not say advanced analytics cannot be built because there are only two calls.
Build the infrastructure, queries, interfaces, and confidence gating now.
When sample sizes are too small, the UI should correctly say:

* Insufficient data
* Early signal
* No actionable recommendation yet

That is different from leaving the analysis system unbuilt.
Do not fake production data.
Do not populate dashboards with invented results.
Do not silently remove or rewrite existing records.
Do not break current calling, packet, enrichment, sourcing, campaign, or board workflows.
Do not postpone script, product, offer, objection, appointment, sales, experiment, recommendation, or routing schemas simply because some are not heavily used yet.
Create them now and integrate them into active workflows where applicable.
29. Definition of done
The project is not complete until:

1. The event-memory migration is active and verified
2. Existing workflows emit real events
3. Notes and actions are permanently stored
4. Call timing is captured
5. Objection usage is captured
6. Scripts are versioned and attributed
7. Products and offers are versioned and attributed
8. Appointment attendance and lifecycle are tracked
9. Sales, payments, refunds, and retained revenue can be linked backward to calls
10. Analytics can calculate the required metrics and interaction breakdowns
11. Weak sample sizes are clearly gated
12. Caller strength and weakness profiles work
13. Recommendations contain evidence and confidence
14. Recommendations can be approved, rejected, applied, monitored, and reverted
15. Experiments can be created and evaluated
16. Daily packets can be optimized using routing recommendations
17. Callers receive relevant recommendations inside their workflow
18. The system measures whether changes helped
19. Historical data is handled honestly
20. All important changes appear in History
21. Existing application features still work
22. Tests pass
23. Production build passes
24. Migrations are safe and documented

30. Final response required after implementation
When finished, provide:
Built
List exactly what was implemented.
Database
List every new table, important column, view, function, trigger, policy, and migration.
Existing workflows changed
Explain which existing workflows now capture new information.
Analytics
List every metric and analysis dimension that now works.
Recommendation behavior
Explain how recommendations are generated, confidence-gated, approved, applied, and evaluated.
Routing behavior
Explain how daily packets and caller assignments are optimized.
UI
List every new page, tab, component, filter, and caller-facing change.
Tests
List the tests run and their results.
Verification
Provide the exact real workflow used to verify that records reached Supabase.
Not fully completed
Be completely honest about anything that remains incomplete.
Do not describe schema files as “built” if the application does not actually use them.
Do not describe a dashboard as working if it contains placeholders.
Do not describe analytics as implemented if it only displays raw counts.
Do not describe memory as active until the migration and real insert tests have passed.
```

### A call intelligence add-on: record, transcribe, assist, learn

*Recording, consent and transcription, with the legal constraints stated as requirements rather than left to the model.*

```
Build a Call Intelligence add-on inside the existing sales-performance platform.
The add-on must record permitted calls, transcribe them, assist callers in real time, automatically update call results, and improve its coaching recommendations using verified historical outcomes.
Do not rebuild the platform. Follow its existing architecture, authentication, database conventions, UI components, permissions, and design system. First inspect the existing calling workflow, caller records, team-performance calculations, lead records, and available telephony integrations.
CORE FEATURES

1. Call recording and transcription

Add recording support to the existing call workflow.
For every call, capture:

* Unique call ID
* Caller
* Lead and business
* Start and end time
* Call duration
* Recording location
* Timestamped transcript
* Speakers separated as caller and prospect
* Recording-consent status
* Telephony status
* Processing status
* Failure reason, when applicable

Recording must only activate according to the platform’s configured consent policy. Display a visible recording indicator. Allow authorized managers to play recordings and review synchronized transcripts.
Never expose recordings across teams or organizations. Apply the platform’s existing tenancy and permission model.

2. Real-time caller assistant

Create a private assistant panel beside the existing calling interface. The prospect must not see or hear it.
During calls, the assistant should display short suggestions such as:

* Suggested next sentence
* Recommended question
* Detected objection
* Important information captured
* Missing qualification information
* Reminder to ask for the owner
* Reminder to request a specific meeting
* Compliance warning
* Follow-up information requiring confirmation

Suggestions must be concise and readable during a live conversation. Show one primary recommendation at a time. Do not flood the caller with paragraphs.
Support these call stages:

* Dialing
* Voicemail
* Gatekeeper
* Decision-maker not confirmed
* Decision-maker confirmed
* Discovery
* Objection
* Qualified interest
* Meeting request
* Meeting booked
* Follow-up requested
* Not interested
* Do-not-call
* Completed

Allow the caller to dismiss, use, or rate each recommendation.

3. Automatic call analysis

When a call ends, analyze the transcript and generate a structured result.
Extract:

* Person reached
* Whether a live person answered
* Whether the owner or decision-maker was reached
* Objections
* Needs discovered
* Interest level
* Qualification status
* Meeting status
* Meeting date and time
* Email address or phone number confirmed
* Follow-up requested
* Follow-up deadline
* New information learned about the business
* Do-not-call request
* Caller strengths
* Missed opportunities
* Recommended coaching point
* Analysis confidence

Do not overwrite human-entered information silently. Show the suggested result and allow correction. Store both the AI result and the final human-confirmed result for accuracy measurement.
Feed confirmed outcomes into the platform’s existing performance dashboard.

4. Immediate follow-up workflow

When a prospect requests an email or expresses qualified interest:

* Create a follow-up task automatically.
* Generate a personalized draft using confirmed call information.
* Assign the task to the appropriate person.
* Set a visible deadline.
* Display it in an urgent follow-up queue.
* Alert the assigned person if it is not handled on time.
* Record when the message was drafted, approved, sent, opened, answered, and converted.

Default target: warm follow-up should be sent within 10 minutes.
Do not send messages automatically unless that capability is explicitly enabled by an administrator.

5. Coaching and learning engine

Create a versioned coaching system that learns from historical calls and verified outcomes.
Use outcomes including:

* Live answers
* Owner conversations
* Qualified opportunities
* Meetings booked
* Meetings attended
* Sales
* Collected revenue
* Gross profit
* Refunds
* Complaints
* Do-not-call events

The system should identify which openings, questions, objection responses, industries, lead sources, times, and follow-up patterns correlate with better outcomes.
It must not permanently rewrite its production instructions after individual calls.
Use this improvement process:

* Gather observations from calls.
* Group comparable calls.
* Require a configurable minimum sample before proposing a change.
* Compare the proposed approach with the current baseline.
* Control for caller, industry, lead source, and time when possible.
* Generate a proposed change with supporting evidence.
* Send the proposal to an administrator for approval.
* Run an A/B test after approval.
* Promote the change only when the primary metric improves without harming compliance, complaints, meeting quality, or downstream sales.
* Preserve the previous version for immediate rollback.

Every change must include:

* Version number
* Exact change
* Reason
* Supporting calls
* Sample size
* Baseline result
* Candidate result
* Confidence level
* Approval status
* Approving administrator
* Deployment date
* Rollback status

6. Business-focused reporting

Extend the existing caller dashboard to include:

* Calls
* Live-answer rate
* Owner-reached rate
* Qualified-interest rate
* Appointment rate
* Meeting-attendance rate
* Sale rate
* Revenue per call
* Cost per owner conversation
* Cost per qualified opportunity
* Cost per attended meeting
* Cost per sale
* Gross profit generated
* Follow-up response time

Separate leading indicators from actual financial outcomes.
Do not label a caller profitable based only on call activity, notes, email addresses, or general interest.
Allow managers to play the calls supporting any important assessment.

7. Data model

Add or extend entities for:

* Calls
* Recordings
* Transcript segments
* Call analysis
* Coaching suggestions
* Suggestion feedback
* Follow-up tasks
* Confirmed outcomes
* Coaching versions
* Learning observations
* Change proposals
* Experiments
* Experiment assignments
* Compliance events

Associate every record with the organization, caller, lead, call, and relevant version where applicable.

8. Administrative controls

Provide settings for:

* Recording enabled
* Recording-consent policy
* Retention period
* Roles allowed to hear recordings
* Transcription enabled
* Live coaching enabled
* Follow-up deadline
* Automatic drafting
* Automatic sending
* Minimum learning sample
* Experiment traffic percentage
* Industries or callers included in experiments
* Required approval roles
* Emergency rollback

Prices, discounts, legal language, consent behavior, autonomous communications, and firing recommendations must never be changed automatically.

9. User interface

Add:

* Live assistant sidebar in the calling screen
* Recording and transcription status
* Post-call review screen
* Recording player with synchronized transcript
* Urgent follow-up queue
* Caller coaching page
* Manager call-review page
* Learning proposals page
* Experiment dashboard
* Version history and rollback screen

Match the existing platform visually. Prioritize a simple, non-technical manager experience.

10. Reliability

Handle:

* Recording failure
* Transcription delay
* Speaker-identification uncertainty
* Call disconnection
* Duplicate events
* Missing lead associations
* Failed follow-up creation
* AI timeouts
* Low-confidence classifications
* Telephony-provider retries

Use background processing for recording analysis. Make event processing idempotent so provider retries do not create duplicate calls or tasks.

11. Delivery approach

Before implementation:

* Inspect the repository.
* Identify the platform’s stack and telephony provider.
* Document the current call and lead flow.
* Identify reusable components and existing database tables.
* Present a concise implementation plan.

Then implement in stages:
Phase 1: recording, transcription, storage, and playback
Phase 2: post-call analysis and human confirmation
Phase 3: immediate follow-up queue
Phase 4: real-time caller assistance
Phase 5: controlled learning, experiments, and versioning
Include database migrations, backend services, UI changes, permissions, audit logging, automated tests, and setup documentation.
Do not use placeholder data in the completed workflow. Preserve existing platform behavior and avoid unrelated redesigns. add this also
```

### The cheap version of call recording

*Rejecting the expensive architecture and naming the MVP: a laptop microphone and a phone on speaker.*

```
Let’s take the low-cost MVP route for now.
Build a browser-based room recorder that uses the caller’s laptop microphone while their personal phone is on speaker. Do not add Twilio or change the existing `tel:` workflow yet.
Please implement:

* Start/stop recording on the call screen
* Clear instructions to put the phone on speaker and avoid headphones
* Microphone permission and input-level check before starting
* Visible recording timer and status
* Use the existing consent logic and fail closed when consent is required but not confirmed
* Delete/discard the recording if consent is refused
* Upload completed audio into the existing `recordings` system
* Associate it with the correct call, caller, and lead
* Playback on the lead/call screen
* Post-call transcription into `transcript_segments`
* Graceful handling of microphone denial, upload failure, page refresh, and network interruption
* Keep the current deterministic outcome form working as a fallback

Favor reliable local capture and upload over real-time AI features. We can add live transcription, coaching, and proper in-platform telephony after the calls start generating revenue.
Before implementing, inspect the existing recording, consent, telephony, storage, and call-screen code and tell me if anything in this request conflicts with the current architecture. If it fits, proceed with the implementation and test the full recording-to-playback flow.
```

### Redesign the dialer to be less bloated

*A whole feature removed rather than added. The reasoning is about the caller's attention during a live call.*

```
Redesign the dialer to be significantly less bloated and more focused on the caller’s immediate job.
The packet already determines which lead appears and why. Callers do not need to see or understand the lead-selection logic. Completely remove the “WHY THIS ONE NOW” section, including business-hours counts, prioritization reasons, and similar routing information.
Reorganize the page around the live call:

1. Keep the business name, phone number, location, local time, website, Maps, and attempt history in a compact header.
2. Make the current call guidance the main focus. Combine “WHO TO ASK FOR,” “CALL OBJECTIVE,” and “SCRIPT” into one guided call section because they currently repeat the same idea.
3. Show one recommended line at a time, with simple controls for “Next line” and “Objection help.”
4. Keep the most common call outcomes visible in a compact, sticky area: No answer, Voicemail, Callback requested, Transferred, Not interested, and Appointment set.
5. Put less common outcomes—Gatekeeper only, Bad number, Decision-maker conversation, and Do not call—inside a “More outcomes” menu.
6. Move business research, AI tips, previous attempts, notes, and lead intelligence into a collapsed “Lead details” side panel. These should be available when needed but should not dominate the main view.
7. Remove the large “Recording off” card. If recording status must be shown, display it as a small status indicator in the header.
8. Remove “Used it,” “Not now,” helpfulness stars, and other assistant-feedback controls from the live calling interface.
9. Show the lead-intelligence update form after the caller chooses an outcome instead of keeping it permanently visible.
10. Do not show every call stage as a large button. The interface should infer stages where possible and only ask the caller for information that affects the next action or the saved result.

The default view should answer only three questions:

* Who am I calling?
* What should I say or do next?
* How do I record what happened?

Use progressive disclosure for everything else. Avoid creating a separate bordered card for every small piece of information. The most important calling controls should remain visible without scrolling on a normal laptop screen.
```

### Owner-enriched leads with direct telephone numbers

*Opens with the two things not to do, before saying what to do.*

```
Upgrade the existing lead-generation system to produce owner-enriched leads with direct telephone numbers.
Do not add Apify and do not replace the existing Google business collection process. The application already finds businesses through Google. The current problem is that callers are dialing main business numbers and rarely reaching owners. In the latest batch, 111 calls reached a live person, but only six reached an owner. Main-line-only leads are therefore not sustainable.
The new required pipeline is:
Google business record → owner identification → direct-number discovery → number validation → enrichment grading → caller assignment
Primary objective:
Each lead should contain the best-supported decision-maker and the best available direct telephone number. Generic business information and main-line numbers alone should no longer be treated as call-ready leads.
Before making changes, inspect the existing:

* Google lead-generation process
* Lead database schema
* Import and deduplication logic
* Background-job system
* Caller assignment process
* Calling interface
* Reporting calculations
* Existing search and enrichment capabilities

Reuse the current architecture and components wherever appropriate.
1. Preserve Google lead generation
Continue using the existing Google process to collect:

* Business name
* Main business number
* Website
* Address
* City and state
* Business category
* Google Maps URL or identifier
* Operating hours
* Existing ratings and metadata

Google remains the source of businesses. The new system enriches those businesses before they enter the caller queue.
2. Add an owner-identification stage
For each business, search a configurable group of credible public sources, including where accessible and permitted:

* Official business website
* About page
* Team page
* Contact page
* State business-registration records
* BBB profile
* Trade and industry directories
* Public professional profiles
* Relevant local-business directories
* Other credible public pages returned through the application’s existing search capability

Search using combinations of:

* Business name
* Website domain
* Address
* City and state
* Main phone number
* Terms such as owner, founder, president, managing partner, general manager, or practice manager

Prioritize decision-makers in this order:

1. Owner
2. Founder or co-founder
3. Co-owner
4. Managing partner or president
5. General manager
6. Practice manager or equivalent operational decision-maker

Store the evidence supporting the match. Never infer or fabricate a person without credible source evidence.
3. Add direct-number enrichment
After identifying the decision-maker, search for that person’s direct telephone number using:

* Existing public-search capabilities
* Publicly available business sources
* One or more configurable contact-data providers
* A sequential provider waterfall when the first provider returns no result

Send providers the strongest available identifiers:

* Decision-maker’s full name
* Title
* Business name
* Website domain
* City and state
* Business address
* Existing public email or professional-profile URL

Use a provider abstraction instead of hard-coding enrichment logic to one vendor. Each provider adapter should return a consistent internal result containing:

* Phone number
* Phone type
* Match confidence
* Provider
* Source or reference identifier
* Date retrieved
* Whether the provider considers it verified

Only call the next provider when the previous provider fails to return a sufficiently confident result. Stop the waterfall once an acceptable direct number is found.
Do not treat the main business number as a direct owner number.
4. Validate returned numbers
Normalize all telephone numbers to a consistent format and check:

* Whether the number is structurally valid
* Whether it is active or reachable when supported
* Mobile, landline, toll-free, or VoIP classification
* Whether it duplicates the main business number
* Whether the identity match supports the proposed owner
* Whether the number conflicts with information from another source

Classify every number as:

* Verified owner mobile
* Probable owner mobile
* Verified owner direct line
* Probable owner direct line
* Main business line
* Unknown

“Verified” must require strong provider or source evidence. A number appearing near a person’s name on an ambiguous page is not sufficient.
5. Add enrichment fields
Add the following fields or their appropriate equivalents:

* decision_maker_name
* decision_maker_first_name
* decision_maker_last_name
* decision_maker_title
* decision_maker_confidence
* decision_maker_source_url
* decision_maker_evidence
* direct_phone
* direct_phone_type
* direct_phone_confidence
* direct_phone_provider
* direct_phone_source
* direct_phone_validated_at
* main_business_phone
* direct_email
* professional_profile_url
* enrichment_status
* enrichment_grade
* enrichment_attempts
* enrichment_cost
* enrichment_sources
* enriched_at
* enrichment_error

Preserve the original Google data separately from enriched information so every field remains auditable.
6. Grade enriched leads
Assign one of these grades:

* A: verified decision-maker with a verified mobile or direct line
* B: confidently identified decision-maker with a probable mobile or direct line
* C: identified decision-maker but only the main business number
* D: no confidently identified decision-maker

A and B leads are call-ready.
C and D leads must not be mixed into the normal direct-call queue. Keep them available for separate main-line campaigns, manual research, or future re-enrichment.
7. Change caller assignment
Prioritize caller assignments in this order:
A → B
Within each grade, prioritize:

1. Verified mobile
2. Verified direct line
3. Probable mobile
4. Probable direct line
5. Highest decision-maker confidence
6. Most recently validated contact information

Show callers:

* Decision-maker’s name
* Title
* Direct number
* Number classification
* Confidence level
* Business name
* Business category
* Location
* Relevant enrichment evidence
* Main business number as a fallback only

Callers must be able to report:

* Correct owner reached
* Wrong person
* Wrong number
* Disconnected number
* Main business line instead of direct line
* Gatekeeper reached
* Owner no longer associated with business
* Owner declined
* Appointment booked

Use this feedback to lower confidence, suppress incorrect data, and improve future provider selection.
8. Prevent false matches and duplicates
Match information using multiple signals:

* Website domain
* Business name
* Location
* Address
* Existing phone
* Decision-maker title
* Current association with the business

Reject ambiguous results instead of attaching questionable information.
Deduplicate by normalized phone number, website domain, Google business identifier, and business address. Do not pay repeatedly to enrich unchanged records.
Cache enrichment results with timestamps. Permit re-enrichment only when:

* The information is older than the configured expiration period
* A caller marks the data incorrect
* The business record changes
* An administrator requests a refresh
* A new provider becomes available for unresolved records

9. Handle enrichment states explicitly
Support these statuses:

* Pending owner identification
* Owner identified
* Pending direct-number search
* Direct number found
* Direct number validated
* Call-ready
* No owner found
* No direct number found
* Ambiguous match
* Conflicting information
* Validation failed
* Provider unavailable
* Enrichment budget exceeded
* Manual review required

Failures must remain visible and retryable. Never silently turn incomplete enrichment into a call-ready record.
10. Add cost controls
Add configurable controls for:

* Maximum enrichment cost per lead
* Maximum number of provider attempts
* Provider priority
* Minimum acceptable confidence
* Monthly enrichment budget
* Per-run budget
* Retry limits
* Data-expiration period

Display estimated and actual enrichment spend. Stop making paid requests when a configured limit is reached.
Prefer providers that charge only when a direct number is successfully found, but keep pricing and credit calculations configurable because providers may use different billing models.
11. Add operational reporting
Report:

* Businesses collected from Google
* Owners confidently identified
* Direct numbers found
* Verified direct numbers found
* Call-ready A and B leads
* Direct-number discovery rate
* Cost per successful direct number
* Cost per verified direct number
* Owner conversations per 100 calls
* Wrong-person rate
* Wrong-number rate
* Meetings per 100 direct-number calls
* Results by enrichment grade
* Results by provider
* Results by number type
* Provider cost versus owner conversations produced

The primary success metric is no longer general live-answer rate. It is:
Owner conversations per 100 calls to enriched records.
12. Privacy and calling controls
Use only data sources and providers that the application is permitted to access. Preserve source attribution and retrieval dates. Support suppression lists, do-not-call flags, data correction, deletion, and provider-specific retention requirements.
Do not automatically call a discovered number merely because enrichment found it. The existing calling system must continue applying its compliance and suppression rules before assignment or dialing.
13. Implementation sequence
Proceed in this order:

1. Inspect and document the existing lead flow.
2. Identify reusable search and enrichment capabilities.
3. Define the provider-neutral enrichment interface.
4. Update the schema and migrations.
5. Implement owner identification.
6. Implement direct-number provider adapters and waterfall logic.
7. Implement number validation and confidence scoring.
8. Update caller assignment to prioritize only A and B records.
9. Add caller feedback and automatic confidence correction.
10. Add cost controls and reporting.
11. Add automated tests for matching, deduplication, provider failure, budget limits, grading, and assignment.
12. Run the application’s relevant test and validation procedures.
13. Report what was implemented, which provider credentials or configuration remain necessary, and any unresolved limitations.

Do not stop after producing a plan. Implement the complete enrichment workflow using the application’s established patterns. Do not fabricate provider integrations or claim that direct numbers are verified when they are not.
```

### Packet, trial and script testing

*Deliberately the lean version. The scope limit is in the title.*

````
Build prompt: Packet + Trial + Script Testing (lean version)
Context
This is an addition to the existing Dispatch Board (Next.js + Supabase + Vercel, repo Peyday007/V2). This is a temporary, lean build meant to ship in a few hours, not a full platform. Do NOT build multi-tenant deployment, master templates, autonomous agents, or n8n orchestration — none of that is in scope. This is scoped down on purpose.
No Twilio integration exists yet. Do not build SMS OTP verification. The customer-facing "agree to trial" action should be a simple web form; the actual lock-in / follow-through happens with a human (me), triggered by a popup/notification on the Dispatch Board.
Goal
Give VAs a one-button way to send a personalized "packet" link to a business owner during a cold call, let the owner view a short gap summary + demo + agree to a free trial on a web page, and have that agreement immediately surface as an actionable item on my Dispatch Board so I can take over manually (contract, onboarding, etc). Also add basic call-outcome stats broken down by gatekeeper script version (A/B/C), with simple threshold-based flags — no AI diagnosis agent, just conditional logic against fixed numbers.
1. Data model additions
Add to the existing leads/businesses table (or a new `packets` table, whichever fits current schema better):

```
packets
- id (uuid, pk)
- lead_id (fk to existing lead/business record)
- token (unique, random, unguessable — used in the public URL)
- status: enum [not_sent, sent, opened, trial_requested]
- created_at, sent_at, opened_at, trial_requested_at
- delivery_method: enum [text, email, both]
- owner_name, owner_phone, owner_email (captured at send time if not already on the lead record)

```

Add to the existing calls table:

```
- script_version: enum [A, B, C]  (nullable — only matters for calls testing the gatekeeper script)

```

2. Packet page — public route `/workshop/[token]`

* Server-side fetch the packet + associated business by token. 404/expired state if token invalid.
* On page load, mark `status = opened`, `opened_at = now()` (only if status was `sent`, don't overwrite later states).
* Content:
   * Business name, city
   * 2-3 gap bullets, generated from existing scraped fields only (no live AI analysis needed): e.g. "X reviews and no visible way for after-hours callers to reach you", "No online booking widget detected on your website" — pull straight from fields already in the business record (review count, website status). If a gap can't be computed from existing data, don't show it — don't fabricate.
   * Embed or link to the existing AI receptionist demo (reuse whatever demo asset already exists — don't build a new one)
   * One CTA: "Start my free 7-day trial"
* Clicking the CTA opens a simple form (no auth, no OTP):
   * Confirm name, phone, email (prefilled if known)
   * Checkbox: "I agree to a free 7-day trial, no cost, cancel anytime"
   * Submit → sets `status = trial_requested`, `trial_requested_at = now()`

3. VA-side: business record panel
Add a panel to the existing lead/business detail view:

```
PACKET
Status: [not_sent | sent | opened | trial_requested]
Recipient: {owner_name} — {business_name}

[ Send Packet ]   (disabled until owner_name + phone present)
[ Copy Link ]     (fallback if send fails or Twilio is down)

Delivery: {last sent method + timestamp}

```

* "Send Packet" button: generates the token if none exists, creates/updates the `packets` row, and sends the SMS automatically via Twilio (see the SMS section below for the exact implementation). The VA does nothing further once they click it — no manual texting required.

4. My-side: trial agreement popup on the Dispatch Board

* Whenever a `packets` row flips to `trial_requested`, this should surface as a notification/banner/inbox item on my main Dispatch Board view — something I'll see the moment I open the board, not something buried in a report.
* Clicking it shows: business name, owner contact info, which VA sent it, timestamp. This is where I take over manually — no further automation past this point.

5. Gatekeeper script A/B/C testing
Add a `script_version` field the VA sets (dropdown or three buttons) on the call screen before/while dialing, alongside the existing outcome buttons (No answer, Voicemail, Gatekeeper only, etc). Seed these three variants as the actual script content shown in the dialer's "Say this" box, so VAs can select which one they're running and see the matching line:
Script A — Stated reason
"Hey, quick one — I'm calling about missed calls turning into missed jobs. Is [owner name] around for a sec?" If pushed: "Just seeing how [Business Name] handles calls that come in when no one can pick up — takes two minutes, I just need a quick word with the owner."
Script B — Assumptive brevity
"Hi, this is [caller name] — is [owner name] available?" If pushed: "It's a quick business question for [him/her] directly, shouldn't take more than a minute."
Script C — Specific hook
"Hi, quick question — I noticed [Business Name] has a lot of reviews online, and I wanted to ask the owner something specific about how new customers reach you. Is [he/she] around?" If pushed: "It's specifically about your review page and call handling — just a couple minutes with the owner."
6. Stats panel — checkpoint flags (no AI agent, just thresholds)
A simple stats view, filterable by script_version, showing per-version:

* Total dials
* Connect rate
* Gatekeeper-pass rate (reached "the owner" state / total connects)
* DM conversation rate
* Trial-requested rate

Apply these fixed threshold flags as visible banners (red/yellow/green), recalculated live, no AI judgment involved:

* Under 25 calls on a script version: "Insufficient data — keep testing"
* Gatekeeper-pass rate < 15% after 50+ calls: "Review this script — high failure at gatekeeper"
* DM conversations < 20% of owner-reaches after 50+ calls: "Review opener — low conversion once past gatekeeper"
* Trial-requested < 1 per 20 DM conversations after 10+ DM conversations: "Review offer/close"

These are just conditional rendering off aggregated counts — no ML, no LLM call needed.
Explicit non-goals for this build

* No OTP verification (agreement is a simple checkbox form, not identity-verified)
* No AI-generated gap analysis (use existing scraped fields only)
* No autonomous pausing or budget changes
* No multi-tenant deployment, templates, or n8n orchestration
* No contract/e-signature — that stays manual, handled by me after the popup notification

Build all of the above in full
Everything in sections 1-6 is in scope and should be built completely — none of it is a stretch goal or a "nice to have." Build order doesn't matter as long as all of it ships: data model, packet page, VA send panel, trial agreement + board popup, and the A/B/C script testing with stats panel.
SMS sending — build this with real Twilio integration
Build actual automated SMS sending via Twilio, not just a copy/paste workaround. When the VA clicks "Send Packet," the server should call the Twilio Messages API directly and send the packet link to the owner's phone — no manual step for the VA beyond clicking the button.
Requirements:

* Use Twilio's REST API (`twilio` npm package) to send an SMS containing the packet link to `owner_phone`.
* Store Twilio credentials (Account SID, Auth Token, and the Twilio phone number to send from) as environment variables (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) — never hardcode them.
* On successful send, set `packets.status = sent`, `sent_at = now()`, `delivery_method = text`.
* On failure (bad number, Twilio error), show the error to the VA on the board and leave status as `not_sent` so they can fix the number and retry — don't silently mark it sent.
* Message template:
"Hi {{owner_name}}, this is {{va_name}} with {{company_name}}. Here's what we found for {{business_name}}: {{workshop_link}}"
* Keep the "Copy Link" button too as a manual fallback for edge cases (e.g. Twilio down, international number issues), but automated send via the button is the primary path.

What I ([name]) still need to do outside this build: create a Twilio account, buy/verify a phone number capable of sending SMS, and add the three environment variables above to the project. The code should assume those exist and fail gracefully with a clear error if they're missing or invalid — not crash silently.
````

### A team updates panel

*Small, sharply specified, one job.*

````
Build prompt: Team Updates panel on the Dispatch Board
Goal
A single place on the Dispatch Board where I (admin) post process/script updates once, and every caller sees the same explanation the moment they log in — instead of me messaging each VA individually every time something changes. This also doubles as onboarding material for anyone new.
1. Data model

```
updates
- id (uuid, pk)
- title (text)
- body (markdown/rich text)
- created_at
- pinned (boolean) -- pinned updates always show at top

```

2. Admin side

* A simple "Post Update" form (title + body, markdown supported) visible only to me/admin role.
* New updates appear at the top of the feed automatically, newest first, pinned ones always above unpinned ones.

3. Caller side

* A "Updates" tab/panel on the Dispatch Board, visible to every caller.
* On login, if there are updates newer than the caller's last-seen timestamp, show a badge/notification so they know to check it before their shift.
* Track `last_seen_at` per caller so the badge clears once they've viewed it (simple read receipt, not required to prove they read it, just to stop nagging them after they've opened it once).

4. Seed the first update with this content exactly
Title: New process — free trial close + packets (read before your next shift)
Body:
What changed: we're no longer booking a 15-minute meeting at the end of the call. Instead, we offer a free trial on the spot and text them a link.
Steps 1-3 stay exactly the same — pain-only, no mention of "AI" or naming the product. Just missed calls, cost, and how they currently handle it. Do not mention what we actually do until step 4.
Step 4 (new close): "Let me start it on your line right now — no cost, no commitment. Any call you miss today gets forwarded to you by text instead of going to voicemail. Sound fair?"
Step 5 (new close): "Perfect. What's the best cell to text the setup confirmation to?"
What happens next: once they give you their number, hit "Send Packet" on their lead — this automatically texts them a link. You don't need to type or send anything yourself, just click the button after step 5.
What's in the packet (for your own understanding, you don't need to walk them through it live):

* Their business name and a couple of specific gaps we found (like missed-call handling, review count)
* A link to see the AI receptionist actually working
* A button for them to confirm and officially start the trial

Gatekeeper scripts: you'll now see Script A / B / C options at the top of the call screen. Use whichever is assigned to that lead — don't switch scripts mid-batch on your own, we're comparing which one works best.
If you're not sure what to say at any point, hit "Objection Help" — don't freelance the pitch.
Notes

* Keep this simple — no rich media, no video embeds needed, just formatted text.
* This is meant to replace one-off Slack/text messages to each caller, so make sure the panel is impossible to miss on login (not buried in a settings menu).
````

---

## Two standalone prompt documents

These were written as files and handed over whole rather than typed into a chat. For anything big, this works considerably better — you can edit it before sending, and the agent gets the whole shape at once.

### VA accountability, performance and decision system

*Written as a standalone document and handed over whole. The opening line is the one that matters: the outcome is not better reports, it is decision-grade visibility.*

```
# VA Accountability, Performance, and Decision System - Master Prompt

Copy everything below into the AI or development agent that will design/build the system.

---

## MASTER PROMPT

You are a principal operations architect, product manager, data engineer, QA leader, and risk analyst. Design an end-to-end **VA Accountability, Performance, and Decision System** for a virtual assistant/caller operation.

The outcome is not “better weekly reports.” The outcome is **decision-grade visibility**:

- If a VA is struggling, I see exactly where and why.
- If a VA's explanation conflicts with the evidence, I see the contradiction and the underlying records.
- If a VA is thriving, I see the verified results, the behaviors causing them, and what should be replicated.
- If the process, tools, lead quality, training, or management is the real problem, the system must not blame the VA.
- My attention should be used to make decisions, not reconstruct facts that already exist in the data.

Every material claim, action, blocker, exception, and result must leave a time-stamped, attributable, auditable trail. Raw event data is the source of truth; summaries are calculated views, never manually asserted proof.

### 1. Start with discovery; do not invent missing facts

Before proposing the final system, identify and clearly label:

1. What is known.
2. What is assumed.
3. What is missing.
4. Which missing answers block architecture decisions.
5. Which reasonable defaults can be used without risk.

Ask only the smallest set of high-value questions needed, covering:

- VA roles and workflows.
- CRM, dialer, Upwork, email, calendar, messaging, file storage, and payment systems.
- Countries/states where the company, VAs, and called prospects are located.
- Whether calls are recorded/transcribed and what consent rules apply.
- Lead stages, dispositions, scripts, offers, required fields, and success definitions.
- Approved non-calling work.
- Expected working hours, breaks, availability, and response-time rules.
- Current integrations/APIs/webhooks and data access.
- Manager escalation preferences and authority limits.
- Baseline volumes and conversion rates by campaign, lead source, market, day, and tenure.

Never fabricate a connector, event, transcript, metric, legal conclusion, or employee claim. When data is missing, say **Unknown** and explain how to obtain it.

### 2. Establish a canonical event model

Create a single normalized timeline for each VA and shift. Every event needs:

- Immutable event ID.
- VA/user ID.
- Source system and source record ID.
- Server timestamp, local timestamp, and timezone.
- Event type.
- Lead/account/contact ID when applicable.
- Campaign, list, and packet/batch version.
- Script/process/SOP version assigned at the time.
- Before/after values for edits.
- Actor: VA, manager, automation, or system.
- Evidence link: recording, transcript, screenshot, message, CRM record, email, calendar event, or file.
- Ingestion time and sync status.
- Confidence/completeness status.
- Tamper/change history.

At minimum, ingest and reconcile:

- Upwork tracked and manual time blocks, memos, activity segments, and available screenshots.
- CRM logins, record views, field updates, notes, tasks, callbacks, stage changes, and exports.
- Dialer call attempts, number, lead, start/end time, ring time, talk time, hold time, disposition, recording, and transcript.
- Lead assignments, packet contents, sequence/order, skipped leads, duplicates, and exhausted batches.
- Emails and packets sent, delivered, bounced, opened, and replied to where legally and technically available.
- Calendar appointments created, attended, cancelled, rescheduled, and no-showed.
- Approved messaging channels and manager instructions.
- SOP/script releases, acknowledgements, quizzes, coaching, and effective dates.
- Blocker/incident reports and resolution events.
- Sales, trials, revenue, refunds, chargebacks, and downstream quality outcomes where relevant.

Use stable IDs to prevent double counting. Preserve raw source records. Make derived metrics reproducible from the raw events.

### 3. Enforce the “one authorized workflow” rule

During paid work, prohibit unapproved dialers, private spreadsheets, handwritten/off-system lead lists, personal accounts, and separate lead sources.

Support a documented exception process. Every exception must record:

- Who approved it.
- Why it was necessary.
- Exact start and end time.
- Systems/data affected.
- How missing evidence will be backfilled.
- When normal workflow resumed.

Do not silently treat off-system work as misconduct when the authorized system failed or management directed an exception. Show it as **Unverified/Exception Pending** until reviewed.

### 4. Make each call independently verifiable

Tie every call to:

- Caller.
- Lead and business.
- Phone number.
- Exact timestamp and timezone.
- Duration components.
- Disposition.
- Notes.
- Recording/transcript where permitted.
- Assigned and detected script/process version.
- Packet/batch version.
- Required steps completed or omitted.
- Callback and next action.
- Outcome and later downstream result.

Validate dispositions against evidence. Examples:

- “Owner conversation” should have a qualifying connected call and transcript/recording evidence when available.
- “Appointment set” should map to a call and an actual calendar record.
- “Packet sent” should map to a delivery event.
- “Callback completed” should map to the scheduled task and follow-up call.
- “Wrong number,” “voicemail,” and “gatekeeper” should be plausible given duration/transcript signals.

Never infer deception from one imperfect signal. Flag a mismatch and cite the exact records.

### 4A. Prevent bad work before an entire shift is wasted

The system must operate as a real-time control layer, not merely an after-the-fact reporting system. It should detect harmful patterns while work is happening, warn the VA, require correction, and automatically pause the affected workflow when continued work would predictably waste leads, damage customers, corrupt data, violate policy, or create legal/security risk.

Use a configurable escalation ladder:

1. **Inline reminder:** explain the missing or incorrect requirement before the next action.
2. **Required correction:** prevent advancement until the current record is completed or a valid exception reason is selected.
3. **Supervisor warning:** notify the VA and manager that the pattern has continued and show the affected records.
4. **Restricted mode:** allow correction, callbacks, training, and manager communication, but block new calls/leads.
5. **Automatic workflow pause:** stop new lead delivery, dialing, sending, exporting, or other affected actions.
6. **Access suspension:** temporarily revoke the minimum necessary permission when there is a severe security, privacy, legal, tampering, or customer-harm risk.
7. **Manager resolution:** require an authorized manager to review evidence, document the decision, and restore or further restrict access.

Controls must act on the smallest affected capability. For example, missing call notes should pause new dialing but still allow the VA to complete notes; suspected exports should block exports without preventing the VA from contacting a manager.

#### Required real-time prevention rules

Design specific thresholds and responses for at least the following:

**Missing information after calls**

- A call record cannot be closed without the minimum required fields for its disposition.
- The next lead cannot open until the previous call has a disposition, required notes, next action, and applicable contact information.
- After 1 incomplete call: show an inline correction prompt.
- After 2 consecutive or 3 total incomplete calls in a shift: block new dialing until records are completed.
- If more than 10% of the shift's calls are incomplete: place the VA in restricted mode and alert the manager.
- Never permit a situation where 80 calls have zero captured information. The workflow should have stopped after the first few failures.
- If the CRM or integration caused the missing fields, preserve local pending data, pause safely, open a blocker incident, and do not blame the VA.

**Invalid or implausible dispositions**

- Warn when duration, transcript, or call outcome conflicts with the chosen disposition.
- After a configurable number of repeated conflicts, require correction or manager approval before more calls.
- Block bulk use of one disposition across many calls without supporting evidence.

**Required script/process omitted**

- Detect missed disclosures, qualification questions, trial offers, cell-number requests, closes, or other mandatory steps.
- Provide a live or post-call reminder after the first detected omission.
- Require a short retraining/check after repeated omissions.
- Pause eligible new calls when a legally required disclosure is repeatedly omitted or when continued calling creates material compliance risk.

**Unworked or skipped assigned leads**

- Require a valid reason for skipping.
- Detect cherry-picking, repeated skipping, and out-of-order calling.
- After repeated unexplained skips, stop new packet delivery and require manager review.

**Callbacks and promises**

- Alert before callbacks become due.
- Escalate overdue high-value or time-sensitive callbacks.
- Prevent the VA from ending the shift with unresolved callbacks unless ownership is reassigned or a manager approves the exception.

**Time tracking without work evidence**

- Warn the VA after a configurable evidence gap while the tracker remains active.
- Ask whether they are on a call, meeting, approved offline task, break, or experiencing a blocker.
- If no response and no evidence appears, pause new work assignment and notify the manager; do not automatically alter or deny recorded pay.
- If the system can safely stop only the company's internal work timer, it may do so after clear notice. Do not manipulate Upwork records or automatically withhold compensation.

**Lead packet exhaustion**

- When the assigned packet is completed, tell the VA to stop tracking or switch to explicitly approved work and request another packet.
- Do not allow repeated calls to exhausted or duplicate leads merely to generate activity.

**Data quality and copied notes**

- Detect blank notes, meaningless notes, repeated copy-paste text, impossible contact details, and required fields filled with placeholders.
- Block record completion until the VA provides meaningful information or selects an approved “no information obtainable” reason.

**Unauthorized tools or data movement**

- Warn and block unapproved exports, mass downloads, personal-email forwarding, unauthorized dialers, or use of private lead lists when technically possible.
- Immediately suspend only the risky capability for high-confidence data-exfiltration, credential-sharing, tampering, or privacy events and notify an authorized manager.

**Customer or brand harm**

- Provide an immediate intervention path for abusive language, prohibited promises, repeated calls to do-not-call contacts, consent violations, or other serious customer harm.
- Stop the affected call/campaign capability when legally permissible and operationally safe, preserve evidence, and escalate immediately.

#### Pre-shift readiness gate

Before a VA can begin production work, verify:

- Correct CRM, dialer, campaign, packet, script, and process versions are loaded.
- Required training and acknowledgments are current.
- Microphone, calling identity, recording/consent configuration, and integrations are working.
- The VA has the correct permissions and no unnecessary access.
- Required fields and save/sync behavior pass a test record.
- A valid lead packet is assigned.
- No unresolved critical blocker makes correct work impossible.

If readiness fails, block production work and direct the VA to the exact remediation step. Allow a manager-controlled override with reason, scope, and expiration.

#### Circuit breakers

Create automatic circuit breakers for patterns that indicate continued production will cause disproportionate harm. Examples:

- Consecutive incomplete records.
- Sudden 100% use of one disposition.
- Abnormally high short-call rate combined with no notes.
- Repeated required-script omissions.
- Multiple calls to suppressed/do-not-call contacts.
- Integration failures causing unsaved records.
- Duplicate calling caused by sync failure.
- Unusual export, deletion, or bulk-edit activity.
- Appointment creation without required contact evidence.
- Excessive customer complaints or opt-outs in a short window.

Every circuit breaker must define:

- Trigger and measurement window.
- Minimum sample size.
- Required data confidence.
- Warning sequence.
- Exact capability paused.
- What remains accessible for remediation.
- VA-facing explanation.
- Manager alert and evidence package.
- Automatic recovery conditions, if safe.
- Manual override authority and expiration.
- False-positive protection.
- Full audit trail.

#### Preventive coaching

The system should intervene before formal escalation when possible:

- Show the correct next step in context.
- Surface the relevant script/SOP section.
- Give examples of acceptable notes for the selected disposition.
- Require a one-question knowledge check after repeated mistakes.
- Route a struggling VA to a short practice queue before restoring production access.
- Confirm improvement over the next defined sample before clearing the issue.

Do not allow warnings to become ignorable notification noise. Acknowledgment alone is not remediation; require the underlying record or behavior to be corrected.

#### Safety and authority boundaries

Automatic controls may protect systems and stop new work, but they must not independently make final employment, contract, pay, or fraud decisions. The system must:

- Clearly disclose applicable monitoring and automated controls in advance.
- Show the VA what triggered the intervention.
- Preserve already completed work and evidence.
- Allow correction, explanation, and blocker reporting.
- Distinguish VA behavior from system/integration failure.
- Provide an emergency manager override.
- Restore access promptly when the condition is resolved.
- Escalate repeated or severe patterns for human decision.

### 5. Generate activity and funnel metrics from raw data

Calculate, never manually accept as proof:

- Assigned, attempted, untouched, skipped, and completed leads.
- Call attempts and unique leads called.
- Dials per active hour.
- Connect rate.
- Live answers.
- Gatekeepers reached and gatekeeper-to-owner transfer rate.
- Owners/decision-makers reached and owner-access rate.
- Meaningful conversations using a defined duration/content rule.
- Call duration distribution, not just averages.
- Callbacks scheduled, due, completed on time, late, and missed.
- Packets sent and delivery rate.
- Trials offered and started.
- Appointments booked, held, cancelled, no-showed, and qualified.
- Sales, revenue, refunds, chargebacks, and retention where applicable.
- Conversion rates between every funnel stage.
- Required-field completion and note quality.
- Follow-up SLA compliance.
- Rework, duplicate work, and invalid disposition rates.

Break metrics down by VA, shift, campaign, script version, packet, lead source, market, list age, day/time, tenure, and manager. Compare like with like; do not rank VAs using materially different lead quality or assignments without adjustment.

### 6. Reconcile paid time with evidence of work

For each tracked block and shift, calculate:

- Scheduled, tracked, manual, approved, and disputed time.
- First and last verified work events.
- Active CRM/dialer span.
- Calls per tracked and active hour.
- Total connected/talk time.
- Notes, callbacks, packets, emails, and approved non-calling tasks completed.
- Longest no-evidence gap and all gaps above a configurable threshold.
- Time before first and after last verified event.
- Overlapping or impossible events.
- Tracker/CRM/dialer timezone and sync differences.
- System outages or delayed ingestion that could explain apparent gaps.

Important: do not treat mouse/keyboard activity or CRM events as a complete measure of work. Calls, meetings, reading, thinking, training, troubleshooting, and approved offline tasks may legitimately produce low computer activity. A gap is an **evidence gap**, not proof of non-work.

Example alert:

> Upwork tracking continued 103 minutes after the final verified CRM/dialer event. No approved non-calling work is recorded. Data coverage is complete. Request explanation before deciding.

### 7. Track actual process compliance, not acknowledgment alone

Version every script, offer, SOP, packet, and process update. Record:

- What version was assigned at each moment.
- Whether and when the VA acknowledged it.
- Training or quiz completion.
- What behavior was actually observed in calls and records.
- Required steps completed, skipped, or performed out of order.

Examples:

- Was the free trial offered when eligible?
- Was a cell number requested?
- Was the correct packet sent?
- Was the new close used?
- Did the VA revert to the old “email a demo” pitch?
- Were required qualification questions asked?
- Was consent/disclosure language used where required?

Use transcript/recording analysis where permitted, with confidence scores and human-review links. Separate **did not know**, **could not do**, and **chose not to do**.

### 8. Require immediate blocker reporting

If something prevents correct work, instruct the VA to pause the affected work/time tracking when appropriate and report it immediately. The incident form must capture:

- What failed.
- Screenshot/error and affected URL/system.
- When it began.
- Last known successful event.
- Calls/tasks completed before failure.
- Scope and severity.
- Whether safe work can continue.
- Approved fallback, if any.
- Assistance needed.
- Resolution time, resolver, root cause, and recovery steps.

No switching workflows first and explaining later unless an emergency fallback was pre-approved. Automatically correlate blocker claims with telemetry, other users' reports, status incidents, and activity before/after the claimed period.

### 9. Run a targeted end-of-shift evidence interview

Do not ask generic questions. First compute the shift record, then ask only questions triggered by anomalies, missing context, unexpectedly strong performance, or coaching opportunities.

Examples:

- “You had 28 live answers but reached no owners. What happened at the gatekeeper stage?”
- “You reported long conversations, but 41 of 51 calls were under 30 seconds. Which exact calls slowed your pace?”
- “You reported a CRM failure from 2:10-3:00, but CRM updates continued until 2:42. What portion was affected?”
- “Your owner-access rate was 2.1x the campaign baseline. What wording or tactic worked?”
- “Three callbacks were completed but not marked complete. Is this a workflow problem or a logging error?”

Require answers to reference event IDs/calls when possible. Compare each answer with evidence. Preserve the original answer, later edits, and AI follow-ups. Give the VA a chance to add evidence or correct honest mistakes.

### 10. Build an Evidence Consistency Index - not a lie detector

Name the user-facing feature **Evidence Consistency**, not “lie detector.” It may be informally described as a BS tracker, but it must never claim certainty about intent or honesty.

Score the supportability of claims using:

- Tracked time vs. verified work timeline.
- Claimed vs. verified calls.
- Reported outcomes vs. mapped source records.
- Duration/content vs. disposition.
- Callback claims vs. completed callback events.
- Process acknowledgment vs. observed behavior.
- Explanations vs. timestamps and telemetry.
- Claimed blockers vs. incident evidence and continuing activity.
- Manual edits, late entries, deletions, exports, or unusual overrides.
- Repeated discrepancies after coaching.
- Data-source health and completeness.

Output:

- **Clean:** claims materially supported; no unresolved significant mismatch.
- **Needs Review:** missing evidence or a plausible mismatch requiring clarification.
- **High Inconsistency:** multiple or material contradictions with reliable evidence.
- **Critical Discrepancy:** a severe, high-confidence contradiction, tampering signal, or repeated unresolved pattern requiring immediate manager review.

For every status show:

- Exact claim.
- Supporting evidence.
- Contradicting evidence.
- Missing evidence.
- Reliability of each source.
- Alternative benign explanations.
- Confidence level.
- Financial/customer/process impact.
- Prior related coaching or incidents.
- Recommended next step.

Never automatically withhold pay, terminate, suspend, accuse, or otherwise punish. High-impact decisions require an authorized human, full evidence access, and a recorded rationale.

### 11. Detect thriving and make it reusable

Do not build only a failure detector. Identify verified excellence:

- Sustained results above a comparable baseline.
- High conversion with strong compliance and downstream quality.
- Excellent notes and follow-up discipline.
- Effective gatekeeper handling and closes.
- Useful blocker escalation that prevented damage.
- Process improvements or lead-quality insights.
- Coaching adoption and trend improvement.
- Reliable performance without gaming metrics.

For strong performance, surface the calls/behaviors that caused it, recommend recognition or expanded responsibility, and propose anonymized examples for training. Guard against rewarding speed that reduces quality, manipulative dispositions, cherry-picking, or easy lead assignments.

### 12. Use controlled test packets correctly

A test packet is for valid measurement, not to occupy an entire shift. Instruct:

> Complete this batch correctly. When finished, stop the tracker and request another packet unless other work is explicitly approved.

Measure:

- Speed and pacing.
- Connection and owner-access rates.
- Process/script compliance.
- Information capture and notes.
- Qualification and closing behavior.
- Follow-up execution.
- Data integrity.
- Improvement across repeated tests.

Use sufficiently comparable packets. Record sample size and warn when the sample is too small for a reliable conclusion.

### 13. Separate root causes before judging the VA

Every negative result must be classified across these possible causes:

1. Data/integration failure.
2. Tool/system outage or poor usability.
3. Lead/list quality or assignment bias.
4. Ambiguous or conflicting management instruction.
5. Training/knowledge gap.
6. Skill gap requiring coaching/practice.
7. Workload/capacity issue.
8. Isolated execution mistake.
9. Repeated noncompliance.
10. Possible intentional misrepresentation or tampering - human review required.

Show evidence for and against each plausible cause. Do not collapse performance, compliance, reliability, and honesty into one opaque score.

### 14. Use a balanced scorecard and trends

Create separate transparent scores (0-100 only if defensible) for:

- Data completeness.
- Attendance/time reconciliation.
- Activity/pacing.
- Process compliance.
- Documentation quality.
- Follow-up reliability.
- Funnel effectiveness.
- Outcome quality.
- Evidence consistency.
- Improvement/coaching adoption.

Show numerator, denominator, formula, comparison cohort, sample size, confidence, and trend. Allow configuration by role/campaign. Never use a universal calls-per-hour target without accounting for talk time, lead type, market, and assigned work.

### 15. Design manager-by-exception outputs

Build four levels:

**Live command center**

- Who is working now.
- Assigned queue and current status.
- Data-source health.
- Active blocker.
- Material idle/evidence gap.
- Due/overdue callbacks.
- Live escalation.

**Shift closeout**

- Verified work and paid-time reconciliation.
- Full funnel.
- Process adherence.
- Outcomes and downstream quality.
- Evidence inconsistencies.
- VA interview answers.
- Wins and coaching opportunities.
- Open actions with owner and deadline.

**Weekly decision brief**

- Trends, comparable baselines, and confidence.
- Top performers and replicable behaviors.
- Improving and declining VAs.
- Process/lead/tool problems affecting multiple people.
- Repeated inconsistencies and financial exposure.
- Recommended decisions, evidence, reversibility, and urgency.

**Incident case file**

- Chronology.
- Claims.
- Raw evidence links.
- Contradictions.
- VA response.
- Manager findings.
- Prior relevant incidents/coaching.
- Decision and rationale.
- Follow-up and appeal/review outcome.

The manager summary should read like:

> VA completed 51 verified calls during 6.4 hours of active CRM/dialer evidence. Paid tracking continued 103 minutes after the final verified event. Twenty-two assigned leads remained untouched. The assigned close was not detected in the reviewed eligible calls. The VA's explanation conflicts with timestamps in two places; one source had a 12-minute sync delay. Evidence Consistency: High Inconsistency (82% confidence). Estimated disputed time: 1.7 hours. Recommendation: preserve access to evidence, request a documented response by [time], manually review the five linked records, and decide after review. Do not automatically withhold pay or suspend access.

### 16. Make alerts actionable and resistant to noise

For every alert include:

- What happened.
- Why it matters.
- Exact supporting records.
- Data completeness and confidence.
- Baseline/threshold crossed.
- Possible benign explanations.
- Impact estimate.
- Recommended action.
- Decision deadline.
- Owner.
- Snooze/suppress/resolve controls and reason.

Deduplicate correlated alerts. Use severity, materiality, repetition, and confidence. Learn from manager resolutions but preserve an audit history of threshold/configuration changes.

For preventive alerts, also state what the system will do next and when. Example:

> Two consecutive calls are missing required notes and next actions. Complete records CALL-1842 and CALL-1843 before another lead can be opened. If a third record is incomplete, production dialing will pause and your manager will be notified. If the CRM is not saving your entries, select “Report system problem” now.

### 17. Prevent metric gaming and false conclusions

Explicitly test for:

- Repeated short calls to inflate volume.
- Duplicate calls or dispositions.
- Cherry-picking easy leads.
- Skipping difficult leads.
- Notes copied across records.
- Backfilled or bulk-edited notes.
- False appointments or packet events without downstream records.
- Strategic timing around screenshots.
- Tracker running during unrelated activity.
- Manipulated dispositions.
- Repeated calls to the same number.
- Unusual exports/deletions/permission changes.

Also test for false positives from:

- Long legitimate calls.
- Meetings/training.
- Research/read-only work.
- Slow systems or outages.
- Offline/cached tracker events.
- Timezone errors.
- Delayed webhooks/sync.
- Shared or recycled phone numbers.
- Bad transcripts or language/accent errors.
- Small samples and poor lead quality.

### 18. Add governance, privacy, and security by design

Before implementation, require legal/HR review appropriate to worker classification and all relevant jurisdictions, especially for call recording, notice/consent, employee monitoring, biometric/camera use, wage/time records, automated employment decisions, and data retention.

Implement:

- Written notice of what is collected, why, and how it affects decisions.
- Least-necessary collection and role-based access.
- No webcam monitoring by default.
- Redaction of passwords, payment data, health data, and unrelated personal information.
- Encryption in transit/at rest.
- Tamper-evident audit logs.
- Retention and deletion schedules by data type and legal need.
- Access/export/correction process where applicable.
- Human review and an appeal/correction path.
- Documented decision authority.
- Periodic bias/false-positive testing.
- Separation of coaching analytics from disciplinary case files where appropriate.
- Alerts for logging/ingestion failures so absence of data is never silently treated as absence of work.

### 19. Define concrete system requirements

Deliver:

1. Current-state data/source inventory.
2. Canonical event schema and entity relationship model.
3. Integration map and ingestion frequency.
4. Metric dictionary with formulas, exclusions, and source fields.
5. Evidence Consistency rules, weights, thresholds, and confidence model.
6. Baseline/cohort strategy.
7. Alert catalog and routing matrix.
8. Dashboard wireframes for owner, manager, QA, and VA views.
9. End-of-shift interview logic and question templates.
10. Blocker workflow.
11. Controlled test-packet workflow.
12. Coaching, recognition, escalation, and investigation workflows.
13. Permissions, audit log, retention, and privacy design.
14. Error states, missing-data behavior, and source-health monitoring.
15. QA/test plan, including false-positive and gaming scenarios.
16. Rollout plan: shadow mode, calibration, pilot, production, and review cadence.
17. Backlog split into MVP, Phase 2, and Phase 3 with dependencies and acceptance criteria.
18. Sample daily, weekly, and incident outputs using clearly labeled fictional data.
19. Real-time prevention rule matrix, escalation ladder, and circuit-breaker specifications.
20. Pre-shift readiness checklist and production-access gate.
21. Restricted-mode, remediation, override, and access-restoration workflows.

### 20. Minimum acceptance tests

The system is not complete unless it can demonstrate:

- A weekly total is reproduced from raw events.
- Every claimed material outcome opens its exact source records.
- Paid time is reconciled without assuming low input activity equals no work.
- Missing/late source data lowers confidence and blocks unsupported conclusions.
- Script/process compliance is tied to the version effective at call time.
- A blocker claim is correlated with timestamps and telemetry.
- A strong performer is detected and their successful behaviors are surfaced.
- Lead quality/campaign differences are controlled before VA comparisons.
- A discrepancy generates questions and human review, not an automatic accusation.
- Every edit, override, threshold change, and decision is auditable.
- A manager can reach a decision from one brief without manually rebuilding the timeline.
- The VA can see the evidence, respond, and correct factual errors.
- An incomplete first call creates an immediate correction prompt.
- Repeated incomplete calls block new dialing before more leads are wasted.
- The VA retains access to fix records and contact a manager while production calling is paused.
- A simulated CRM-save failure pauses work, preserves pending information, and creates a system incident rather than a VA misconduct finding.
- A circuit breaker can stop a high-risk action while leaving unrelated safe work available.
- Every automatic pause has a visible reason, evidence, remediation path, override authority, and restoration condition.

### 21. Required response format

Respond in this order:

1. Executive summary.
2. Known facts, assumptions, and blocking questions.
3. System architecture and data flow.
4. Canonical data model.
5. Metrics and formulas.
6. Evidence Consistency methodology.
7. Dashboard and report specifications.
8. Workflows and escalation rules.
9. Privacy, security, and governance.
10. MVP/Phase 2/Phase 3 implementation plan.
11. Acceptance tests.
12. Risks, failure modes, and mitigations.
13. Final decision brief template.

Be specific enough that a product designer and engineer can build from the response. Use tables for exact field mappings and metric definitions. Cite any external claims. Clearly distinguish facts, calculations, inferences, and recommendations. Do not produce vague advice, motivational language, or a generic dashboard wishlist.

---

## Research notes behind the guardrails

- Upwork describes its Work Diary as a billing record with screenshots and activity meters. It also explicitly notes that calls, reading, and thinking can show low input activity, so low activity is a review signal rather than proof of non-work.
- Upwork documents manual time, cached/offline time, missing screenshots, and timing limitations; the design must treat tracker data as one source among several.
- U.S. Department of Labor guidance says covered employers' time records must be complete and accurate and reflect actual hours worked. Legal applicability depends on worker classification and jurisdiction.
- NIST audit guidance supports timestamps, actor/user identifiers, event descriptions, protected audit records, and report/reduction capabilities for later review.

This prompt is operational design guidance, not legal advice. Obtain jurisdiction-specific legal/HR review before deploying employee monitoring, call recording, or automated employment-decision features.
```

### AI system manager — implementation directive

*The follow-up, and a sharper instrument: build it, do not describe it. Contains the single most useful sentence in this whole file — "Do not report built when logic exists but is not wired into the real workflow."*

```
# AI System Manager - Implementation Directive

Continue working in the existing application. Do not merely produce another architecture document, gap analysis, estimate, or proposal. Inspect the current code, preserve everything that already works, and **implement every missing part of the VA Accountability, Performance, Prevention, and Decision System described below**.

## Scope decision

Upwork integration and paid-time reconciliation are explicitly out of scope. Do not build or imply the ability to determine whether billed time equals worked time. Remove Upwork-specific dependencies from the implementation plan, but keep the architecture extensible for a future time source.

Everything else is in scope.

The “System Manager” is **not a human manager position**. It is an AI operations manager that continuously observes the system, intervenes during work, manages routine remediation, evaluates evidence, recognizes strong performance, and escalates only decisions that require the owner.

## First: verify the handoff against the code

Treat the prior report as unverified until confirmed in the repository. Inspect the schema, services, dialer, APIs, event model, analytics, tests, permissions, and user interfaces. Create a short implementation matrix showing:

* Existing and verified.
* Existing but incomplete.
* Built but not connected.
* Missing.
* Incorrect or unsafe.

Then implement the missing/incomplete pieces. Do not rebuild working features without a concrete reason. If the handoff claims an after-call gate exists, find it, test it, and connect it to the real production path. If it does not exist or is defective, implement it correctly.

## Required outcome

After implementation:

* A VA cannot make dozens of calls while recording no useful information.
* The AI System Manager sees each material action and result as it occurs.
* It distinguishes VA mistakes from application, integration, lead, training, and management failures.
* It warns, coaches, restricts, pauses, and restores access using explicit rules.
* It detects contradictions without claiming to read minds or automatically declaring someone a liar.
* It identifies excellent performance and the behaviors producing it.
* It presents the owner with conclusions and evidence instead of requiring the owner to investigate.
* Every AI action, override, explanation, correction, and owner decision is auditable.

## Build the AI System Manager

Implement the AI System Manager as a durable application service/control plane, not a chat-only feature. It must consume normalized system events and maintain state for every VA, active work session, call, lead packet, incident, restriction, coaching assignment, and evidence-consistency case.

The AI System Manager must have:

1. A deterministic policy engine for hard safety and workflow rules.
2. An AI reasoning layer for transcript interpretation, anomaly explanation, interviews, coaching, summaries, and recommendations.
3. A state machine for warnings, remediation, restricted mode, pauses, escalations, and restoration.
4. A scheduler/worker for continuous monitoring, due callbacks, unresolved incidents, shift closeout, and periodic briefs.
5. Tool/API permissions that enforce least privilege.
6. A complete audit trail of inputs, rule versions, model outputs, actions, confidence, overrides, and outcomes.
7. Owner-configurable policies, thresholds, campaign rules, and authority limits.

Hard controls must be deterministic. Never let a probabilistic model directly decide whether a legally required disclosure occurred, permanently suspend an account, delete data, withhold pay, terminate a contract, or make a final fraud finding without the required evidence and owner review.

## Wire the after-call gate into production

Connect the gate to the actual dialer and outcome-saving flow. It is incomplete until the production dial action is server-side blocked.

Required default behavior:

* First incomplete eligible call: warn immediately and require the missing fields.
* Two consecutive incomplete eligible calls: pause new production dialing.
* Three total incomplete eligible calls in the current work session: pause new production dialing.
* More than 10% incomplete after the configured minimum sample: enter restricted mode and open an AI System Manager review.
* The next lead must not open until the prior call contains the disposition-specific minimum information or a permitted exception.
* The VA must retain access to complete records, perform allowed remediation, handle already-promised callbacks when safe, report a blocker, and communicate with the owner.
* The restriction must name the affected call IDs, missing requirements, exact correction, next consequence, and restoration condition.

Implement server-side enforcement so refreshing, direct API calls, multiple tabs, race conditions, or client manipulation cannot bypass it.

## Add system-failure awareness

Add and propagate reliable signals for failed saves, delayed synchronization, transcription failure, dialer failure, CRM outage, stale data, and ingestion failure.

System-caused missing information must not count as caller misconduct. When the application cannot safely preserve required information:

* Preserve pending data locally/server-side where possible.
* Stop new affected work before more records are lost.
* Create an incident automatically.
* Notify the VA and owner of the system problem.
* Restore operation after health checks pass.
* Reconcile queued data without duplicates.
* Keep an audit trail.

Evaluate system health before evaluating VA compliance.

## Implement pre-work readiness gates

Before production calling begins, verify:

* Correct campaign, lead packet, script, prompt, SOP, and offer versions.
* Required training and acknowledgments.
* Dialer, microphone, CRM save, transcription/recording configuration, and necessary integrations.
* Calling identity and consent/DNC configuration.
* Required permissions and absence of unnecessary permissions.
* Successful test record/save or equivalent health check.
* No unresolved critical incident.

Block only production capabilities affected by a failure. Show exact remediation. Allow an owner override with reason, scope, expiration, and audit record.

## Implement real-time circuit breakers

Create configurable, server-enforced circuit breakers for:

* Missing required call information.
* Blank, meaningless, placeholder, or inappropriate copy-pasted notes.
* Disposition conflicts with duration, transcript, recording, or outcome evidence.
* Repeated use of one implausible disposition.
* Repeated required-script or process omissions.
* Missing legally required disclosures where applicable.
* Calls to suppressed/DNC contacts.
* Unauthorized repeated calls.
* Skipped/cherry-picked assigned leads.
* Duplicate calls caused by user behavior or synchronization failure.
* Overdue callbacks and broken promises.
* False/unmapped appointments, trials, packets, or outcomes.
* Unauthorized exports, mass downloads, deletions, bulk edits, personal forwarding, or suspicious data movement.
* Sudden complaint, opt-out, or customer-harm spikes.
* Lead packet exhaustion.
* Broken integrations that would corrupt or lose more work.

Every circuit breaker needs a trigger, measurement window, minimum sample, confidence requirement, warning sequence, exact capability restricted, allowed remediation actions, restoration condition, owner override, false-positive protection, and audit record.

## Implement the AI intervention ladder

Use the smallest sufficient intervention:

1. Contextual reminder.
2. Mandatory correction before continuing.
3. AI coaching or micro-training.
4. Warning with affected records and next consequence.
5. Restricted mode.
6. Pause of the affected production capability.
7. Temporary security restriction for severe high-confidence risk.
8. Owner escalation for irreversible, ambiguous, contractual, payment, or fraud-related decisions.

Acknowledging a warning is not remediation. Require the underlying record, behavior, training, or system condition to be corrected.

The AI System Manager may automatically stop or restrict operational activity when continuing would waste leads, corrupt data, violate policy, create customer harm, or create a security/privacy risk. It may not independently terminate a person, cancel a contract, withhold/dispute pay, or issue a final accusation of fraud or lying.

## Implement Evidence Consistency without Upwork

Build an explainable Evidence Consistency system using available operational data only:

* Claimed calls versus call records.
* Disposition versus duration/transcript/recording.
* Owner/decision-maker claims versus evidence.
* Callback claims versus scheduled and completed events.
* Appointment, packet, trial, and sale claims versus corresponding source records.
* Script/process acknowledgment versus observed execution.
* Blocker explanations versus timestamps, telemetry, and activity.
* Skipped leads, duplicate work, copied notes, bulk edits, deletions, exports, and unusual overrides.
* Repeated discrepancies after coaching.
* Data-source completeness and health.

Statuses:

* Clean.
* Needs Review.
* High Inconsistency.
* Critical Discrepancy.

For every finding show the exact claim, supporting evidence, contradicting evidence, missing evidence, source reliability, benign alternatives, impact, confidence, prior related events, and recommended action.

Do not call it a lie detector in the product. Do not infer intent from a mismatch. Do not include time-work or billing conclusions without a legitimate future data source.

## Implement AI-generated targeted interviews

At work-session closeout and after material anomalies, the AI System Manager should ask only evidence-triggered questions. Questions must cite the relevant records and request specific explanations or evidence.

Preserve:

* Original question.
* Evidence available when asked.
* Original answer.
* Edits/follow-ups.
* New evidence.
* AI reassessment.
* Final owner decision when escalated.

Allow the VA to correct honest mistakes and report tool failures. Challenge contradictions calmly and specifically.

## Implement AI coaching, remediation, and restoration

The AI System Manager should:

* Explain the correct next action.
* Surface the exact relevant SOP/script section.
* Provide disposition-specific note examples.
* Assign short knowledge checks.
* Assign practice/test queues after repeated mistakes.
* Measure the next defined sample for improvement.
* Restore access automatically only when objective, pre-declared remediation conditions are met.
* Escalate when the condition is ambiguous, repeatedly fails, or involves serious risk.

Record why access was restricted, what was required, what evidence satisfied restoration, who/what restored it, and the policy version used.

## Detect and develop excellent performance

The AI System Manager must not be only a punishment engine. Detect verified excellence while controlling for campaign, lead source, list quality, market, time, sample size, and tenure.

Identify:

* Strong conversion and downstream quality.
* Excellent notes and information capture.
* High callback reliability.
* Effective gatekeeper, qualification, and closing behavior.
* Fast adoption of coaching/process changes.
* Helpful blocker reporting.
* Sustainable performance without metric gaming.

Surface the exact calls and behaviors causing success. Recommend recognition, added responsibility, or anonymized training examples. Do not reward speed that sacrifices quality or encourages cherry-picking.

## Implement controlled test packets

Build comparable, versioned test/practice packets with explicit completion rules. When a packet is complete, stop new activity and require another assignment unless other work is approved.

Measure speed, connection rate, owner access, process compliance, information capture, qualification, closing, follow-up, data integrity, and improvement. Display sample sizes and uncertainty.

## Build the AI System Manager interface

Create an owner-facing AI System Manager console with:

* Live VA/work-session status.
* Current campaign and packet.
* System/data-source health.
* Active warnings, restrictions, pauses, and incidents.
* Missing records and required corrections.
* Due/overdue callbacks.
* Funnel and process-compliance metrics.
* Evidence Consistency cases.
* AI questions and VA answers.
* Coaching assignments and restoration progress.
* Verified wins and replicable behavior.
* AI recommendations awaiting owner decision.
* Complete evidence timeline.

Also create a VA-facing view showing expectations, current status, warnings, exact affected records, remediation, coaching, evidence responses, and restoration progress. Do not expose unrelated employees' data.

The owner must be able to ask the AI System Manager natural-language questions and receive evidence-linked answers. AI summaries must distinguish facts, calculations, inferences, unknowns, and recommendations.

## Build closeouts and decision briefs

Generate:

* Work-session closeout.
* Daily operational summary.
* Weekly decision brief.
* Incident case file.
* Performance/coaching history.

Each should include verified activity, funnel, process compliance, data quality, callbacks, outcomes, inconsistencies, explanations, wins, root-cause assessment, open actions, owner, deadline, confidence, and evidence links.

Classify root cause across system failure, integration failure, lead quality, conflicting instructions, training gap, skill gap, capacity, isolated mistake, repeated noncompliance, and possible intentional misrepresentation requiring owner review.

## Permissions and authority

Replace any single shared admin passphrase with appropriate authenticated identities and least-privilege permissions.

At minimum model:

* VA.
* Owner.
* AI System Manager service identity.
* Technical/system service identities.

The AI System Manager must receive only the permissions needed for each tool/action. High-impact owner-only operations must be impossible through AI credentials. Overrides require reason, scope, expiration, and audit.

## Governance and safety

Implement disclosure, consent configuration, access control, redaction, retention, evidence preservation, correction/response paths, auditability, model/rule versioning, and data-source health monitoring.

Test false positives involving voicemail notes, long legitimate calls, poor transcripts, accents/languages, outages, delayed events, small samples, bad lead quality, duplicate phone numbers, and ambiguous outcomes.

No absence of data may silently become evidence of absence. Lower confidence and pause unsupported conclusions when sources are incomplete.

## Testing requirements

Add unit, integration, end-to-end, concurrency, authorization, migration, failure-injection, and mutation tests.

At minimum prove:

* One incomplete eligible call produces the correct warning.
* Two consecutive incomplete calls block the next production dial server-side.
* Three total incomplete calls trigger the configured restriction.
* Eighty empty calls are structurally impossible.
* A save failure is treated as a system incident, not caller misconduct.
* The VA can correct records and contact the owner while dialing is paused.
* Direct API calls, multiple tabs, stale clients, and races cannot bypass the restriction.
* Voicemail notes do not create a copy-paste false positive where detailed notes are not required.
* Restoration requires the configured evidence and is audited.
* A DNC or severe security circuit breaker acts immediately.
* Evidence Consistency cites real records and lowers confidence when data is missing.
* The AI cannot perform owner-only decisions.
* A strong performer is detected using a fair comparison cohort.
* Every AI action can be reconstructed from the audit trail.

Run the complete existing test suite after each meaningful integration. Fix regressions rather than weakening tests. Mutation-test the rules whose failure would allow wasted calls, data loss, DNC violations, bypassed restrictions, or misattribution of system failures.

## Execution rules

* Implement the work; do not stop after describing it.
* Make safe assumptions when the code answers the question.
* Ask the owner only when a missing choice would materially change business behavior, legal exposure, or irreversible architecture.
* Use feature flags and shadow mode for high-impact AI interventions.
* Calibrate thresholds on historical data where available before enabling automatic pauses broadly.
* Preserve existing user changes and working behavior.
* Use migrations for schema changes.
* Keep changes reviewable and commit in coherent units if repository policy permits.
* Do not claim a feature is complete until it is connected to the production path and verified end to end.

## Required completion report

At the end, provide:

1. What was already present and verified.
2. What was implemented.
3. What was connected to production paths.
4. Schema/API/UI changes.
5. AI System Manager authority and safeguards.
6. Tests run and results.
7. Features in shadow mode versus actively enforcing.
8. Remaining genuine blockers, if any.
9. Exact owner decisions still required.

Do not report “built” when logic exists but is not wired into the real workflow. The definition of done is that the complete non-Upwork system operates end to end, prevents avoidable waste during work, and gives the owner evidence-backed control through the AI System Manager.
```

---

## The short ones

Verbatim, typos and all. These are worth more than they look: almost every one of them is a case where what got built was technically what I asked for and still not what I wanted.

### Lead quality and sourcing

> dude, i need it to give me the leads so i CAN call. also way is it just roofers, it needs to be home services that can use ai systems

> why is there all these extra buttons? when i press generate campaign, it should ask me how many leads to generate. it should and can do the rest of the building

> thats still too much. i want a mix of different services so i can naturally collect data. city and state doesnt matter. also how do i access the caller only site?

> look at the call tip. it suggested me a company that just doesn't make sense to call. 30,000 reviews. the possiblity of me scoring that is lower. also i dont know if its in pace but create pipeline that can enrich the leads. like itll check this website this one and this one until it can conclude john is the owner

> okay, look at where im getting my leads from and then make it so most of my leads come from one party consent states

> Please fix the email-scoring mistake first so we stop discarding personal addresses such as an owner’s Gmail when they’ve deliberately published it in a `mailto:` link.
> Then add personal-email discovery to the enrichment waterfall. The system should prioritize:
>
> 1. A verified decision-maker’s personal work email
> 2. An owner’s published personal email
> 3. A generic business email such as `info@` or `office@` only as a fallback
>
> Please keep the email source and type recorded so we can measure how many addresses are personal versus generic before sending.

### The dialer and the callers

> okay so a caller got a lead but it just has the number and name on it. i cant open it up to see  notes on them, what to do next, etc. there needs to be a way to open the lead info and then have reccommendations given by ai. For example, we offered tools A and B but they may be more suited for C and D, the next move is to do this this and this as well as an expected timeline. actually just make a section for client relationship

> can you put the ai call tip under the objective

> okay i really need the baseline target numbers right next to the callers. Yeah the caller may be strong in this bad batch.

> can you also include the callers information. Thats the big one because i need to know if they are lacking or not. can you make it so itll build a profile for each caller. then take in the information and give me recommendations like they need to be dropped, promoted. also itll learn what they are good at and then adjust packets to them. like they are strong closers but weak openers, they do best with industrial services. also can you re work the call  backs into the packets automatically? it feels redundant if i have to put the calls back into it

> Check over the dialer. is there anything thats holding them back?

### Packets

> i just checked it and its way too much manual work. last one i could say generate a packet and it would generate it. this one has me picking and doing things it should do itself. also alot of the things are meshed in that shouldnt be. the caller section should be on a completely different website and they shouldnt be able to see the innerworkings

> Can we make the packets alot more adaptive. Like can leads be moved around as time progress. Like if callers start calling at one time but the biz timezone is another. They can be calling at 9am in one place but the pumbing timezone is 6am

> please add the packet to the emails. so they  can press on the link and see the plan

### Consent and recording

> what does this mean? i want a toggle that will record on party consent and just not record on two party consent. Also the packet isnt working. i press copy packet and nothing is being copied. can you make it so it generates a packet. nothing but recommendations, not demo videos

> why does this consent button exist if its only on for one party consent states

> go into the leads, and make so when a two party state emerges, no recording can be made at all. That way human error cant find a way to make an error. Then make recording mandatory on one party states

> why is this still here? Asking if they agree.  it only calls on one party consent states. The system should turn it on when its a callable state and turn it off when its not. ALso recording has to be mandatory so they cannot call until the mic is on

### Email automation

> can you connect instantly pretty seamlessely to this build? Like use the information, scripts, updates to build out a bot that will take care of instantly emails aswell was build out the instantly email automation

> Can you make it smarter. it should be able to draft up its own squences, send leads over without me having ask (looks at the max amount it can send over and refills). Also has an ai prompt where i can speak regularly, explain what i want and they transform it into high converting emails. Also please dont make me hold its hand, it can figure out how many emails it should send and the space inbetween

> can i turn on smart filling where itll look at the max numbers each email can do and automatically adjust to it. Can it also do the changing itself. there are few accounts taht are limited at 30 but can do 90 now. i do not feel like going in and fixing that. I should be able to turn on smart option and does that for me

> so does it work? are the email leads being sent to DM emails and not customer service? Can you put in a button that i can press to kick it off

> Multiple issues, i had to manually put these in. they look like customer service instead of actual personal emails. they dont have any name attached to it

> okay so why cant you just make it so it auto refills?

### Learning, testing and analytics

> i understand you cannot have optimized results after nothing but are the tools in there so once calling and data is being taken. it can?

> also can you make a test feature where it will automatically generate 100 leads for the caller to call and then rank them. cut, add to team, etc

> Is there a way to accurately track time in the website? I pay on a separate site and the way of tracking there time isnt that accurate. I need to know if there are people lagging behind, not telling the truth, etc

> Can you add everything in the close that gap part. fort the review, make ai have the last judgement, i cant manually decide what was said on 300 calls daily.

> Make a/b/c testing random lol. One lead they get script a, on lead b. Also test as many as you see fit, don’t anchor it down to just three. Also please dive deeper into diagnostic. Everyone has the same “missed calls” use context. If it was on page 4 of Google, could benefit from SEO optimization, this means this which can be fixed by this. Make the diagnostic much smarter. AIM to ATLEAST have 2/4 diffferent sellable points. Also run the diagnostic, make a rough outline of how much they make and how much they can afford. A 3 person plumbing company might not be able to afford a 7k build while a regional one can. Ofcourse don’t show their rough earning or anything like that on the packet.

> Have the learning become a positive parasite. The more trust and things we learn about the company, the better optimized tools and things of that become. Make everything an ecosystem

> Can you look over the different sections. I feel like some are basically the same thing, some or outdated, not needed, or should be smashed together.

### How to work with the thing building it

> so instead of me having to ask for double, cant you just change it so it does enough to fulfill what i asked?

> okay before you do it, what will change? how will that chnage affect me? how will that change affect my callers trying to sign into the account

> Please put a little prompt helper in the chat. Sometimes I need to tweak little things like switch out this prompt for another, little things like that, that I don’t see a reason to go to you for

> explain what the seed it exactly part is and what you put in verbatim

> its still showing the same thing. slow down and genuinely work throw it to solve

> no but i added an additional 200 leads and its not popping up. He cant see them nor is my buttons working properly and than an issue. Take your time, this needs to be the last prompt covering this.

> my question is why? ive added all of these things before

> yes i authorize the builds. Building this will now make the calling good?
