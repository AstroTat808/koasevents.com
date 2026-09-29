# Email inline asset hardening

Released 2026-09-29.

- Business CRM emails now include the inline logo attachment referenced by their CID image.
- All current branded Koa's Events email senders validate CID references before calling Resend.
- Email Health now reports inline CID/attachment integrity and turns red if the branded logo reference loses its matching attachment.
