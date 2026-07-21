# WhatsApp Cloud API setup

Sent.dm remains configured only for customer login OTP. Order, shipping, and
marketing messages use Meta's official WhatsApp Cloud API.

## Meta templates

Design and submit these templates from **Admin → Settings → WhatsApp Templates**.
The application stores drafts and approval status in the database and submits
them to Meta's Message Templates API. Template names, content, language, and
approval status are stored only in the database.

### Order-status templates

Create a separate **Utility** template for every Admin Orders status:

- Placed
- Payment pending
- Confirmed
- Ready to ship
- Shipped
- In transit
- Delivered
- Returned
- Cancelled
- Failed
- Returned to origin (RTO)
- Refunded

Every order template starts with these variables:

1. Customer name
2. Short order number

Placed, payment-pending, and confirmed templates also use the formatted order
total as `{{3}}`. Shipped and in-transit templates use the tracking URL as
`{{3}}`. The Admin designer shows and validates the exact contract for each card.

### Return-request templates

Create separate Utility templates for requested, accepted, rejected, out for
pickup, pickup cancelled, picked up, and completed returns. Every template uses
customer name and short order number. Requested also includes the return reason;
rejected also includes the admin note.

### Refund-coupon templates

Create one Utility template for return/store-credit coupon issuance. It uses
customer name, short order number, coupon code, credited amount, shipping
deduction, and expiry date. Admin can issue the coupon with no deduction or deduct
the order's shipping charge. Passive labels such as pending eligibility or coupon
active/inactive do not send customer messages.

### Text marketing

Category: **Marketing**. Body (Meta-safe: no variable at start/end, enough fixed text):

```text
Hello {{1}}, thank you for being part of Singari Sarees. Here is our latest update: {{2}}. More details for you: {{3}}. Shop this collection here: {{4}}. We look forward to seeing you again soon.
```

Body variable order:

1. Customer name
2. Campaign heading
3. Campaign story
4. Clickable campaign URL (`http://` or `https://`)

### Image marketing

Category: **Marketing**. Add an **image header**, then use the same body and
body-variable order as the text marketing template. The Admin Panel uploads the
sample through Meta's Resumable Upload API and stores the returned header handle.
Existing three-variable marketing templates must be replaced or resubmitted with
the fourth URL variable before they can be activated and used by Admin Users.

### Meta body rules (all templates)

- Do **not** start or end the body with a variable
- Do **not** put a variable alone on its own line
- Keep enough fixed text around variables (short messages with many `{{n}}` get rejected)
- Variables stay only in the body (not header/footer)

### First-login welcome

Create and approve the **Customer Account → First-login welcome** Utility
template. It uses `{{1}}` for the customer name. After activation, the app
enqueues it once when a customer completes their first successful OTP login.
Login does not wait for Meta: a durable database outbox retries temporary,
unconfigured, or inactive-template failures and resumes pending work after a
server restart. The deduplication key prevents duplicate welcome messages when
the same OTP is submitted concurrently.

## Meta and environment configuration

1. Create a Meta app, add WhatsApp, and connect the Singari Sarees WhatsApp
   Business Account and sending phone number.
2. Create a System User in Meta Business Settings, grant it access to the app
   and WABA, and generate a permanent token with `whatsapp_business_messaging`
   and `whatsapp_business_management`.
3. Copy the permanent token, Meta App ID, phone-number ID, WABA ID, and app
   secret into the matching `WHATSAPP_CLOUD_*` variables in `.env`.
4. Set `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` to a private random value.
5. Use this public HTTPS callback in Meta:
   `<BACKEND_BASE_URL>/api/v1/whatsapp/webhook`
6. Enter the same verify token in Meta and subscribe the WABA webhook to the
   `messages` field.
7. Deploy the database migration before enabling sends:
   `npm run prisma:migrate:deploy`.

## Admin approval workflow

1. Open **Admin → Settings → WhatsApp Templates**.
2. Edit a guided template without changing the required variable order.
3. Enter realistic sample values for every variable. Meta uses these during review.
4. For image marketing, upload a JPG or PNG sample. This requires
   `WHATSAPP_CLOUD_APP_ID` and the permanent access token.
5. Save the draft, review the rendered WhatsApp preview, then select
   **Submit to Meta**.
6. Use **Refresh status** until Meta returns `APPROVED` or `REJECTED`.
7. After Meta approves a template, select **Activate**. Approval and activation
   are separate: approved-but-inactive templates do not send WhatsApp messages.
   Use **Deactivate** at any time to stop that template without affecting email.
   `PENDING` and `APPROVED` content is locked to prevent accidental resubmission.
   A rejected template can be corrected and submitted under an available name.

Meta, not the application, makes the final approval decision. Submission requires
the `whatsapp_business_management` permission. Message sending additionally
requires `whatsapp_business_messaging`.

Meta cannot verify a localhost callback. Before a permanent domain is available,
use a stable public HTTPS deployment URL or a temporary HTTPS tunnel and update
the callback when the production domain is ready.

The API acceptance ID is stored on each marketing log. Signed webhook updates
then record accepted, delivered, read, or failed timestamps. Duplicate status
events are safe and do not change campaign counts twice.
