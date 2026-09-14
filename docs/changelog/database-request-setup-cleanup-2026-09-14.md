# Release database request resources when setup fails

Keep request header construction and authority stamping inside the shared client cleanup boundary. A refusal before transport now immediately removes its deadline timer and caller cancellation listener, across ordinary, maintenance and seeding clients. The original error is retained and no request or retry is sent.

Regression checks reproduce invalid-header and authority-preparation failures on all three clients. Existing response-body deadlines, caller cancellation, retry boundaries, actor scoping and real HTTP transport remain covered. This source defect is separate from the unresolved live settlement holds.
