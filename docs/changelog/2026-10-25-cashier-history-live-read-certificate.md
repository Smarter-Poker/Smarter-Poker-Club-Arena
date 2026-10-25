# Cashier History Requires A Successful Live Read

The existing deep browser check allowed a working retryable-error screen as
one acceptable outcome. That tests resilience, but cannot certify that the
new history feed works in production.

The dedicated, authenticated read-only Cashier suite now requires successful
feed and summary responses, cursor paging when an older page exists, server
search and real rendered receipts. Its maintained staff identity switches
between the club and its own book and checks an existing cash-out approval's
actual accepter and invoice. It records screenshots at 375, 393, 768 and 1440
pixels. It never creates or approves a test cash-out, funds an account or
impersonates another role. Other role scopes retain their separate native
PostgreSQL qualification.

The mounted component test also enters through the requested Transaction
History button beside Players in Simple view and verifies the named panel,
instead of relying on the Advanced tab strip. That existing entry already
passes; no application behavior or artwork changes were required.

Local mounted tests and Playwright discovery are preparation evidence only.
The existing post-deploy workflow must execute the credentialed live test and
retain its response and screenshot evidence before it is a live certificate.
