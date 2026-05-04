import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../common/errors';
import { Resend } from 'resend';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class MailService {
  private readonly resend = new Resend(process.env.RESEND_API_KEY);

  private getPublicAppBaseUrl(): string {
    const explicit = process.env.APP_URL?.trim();
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }
    const isDeployedProd =
      process.env.NODE_ENV === 'production' ||
      process.env.RAILWAY_ENVIRONMENT === 'production';
    return isDeployedProd ? 'https://www.devshub.dev' : 'http://localhost:3000';
  }

  private buildVerificationEmailContent(params: {
    username: string;
    verifyUrl: string;
  }): { html: string; text: string } {
    const safeName = escapeHtml(params.username);
    const { verifyUrl } = params;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verifica tu correo</title>
</head>
<body style="margin:0;padding:0;background-color:#e8ecf4;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#e8ecf4;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);">
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#4338ca 0%,#6366f1 50%,#818cf8 100%);"></td>
          </tr>
          <tr>
            <td style="padding:36px 40px 28px;">
              <p style="margin:0 0 8px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6366f1;">
                Confirmación de correo
              </p>
              <h1 style="margin:0 0 16px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:24px;font-weight:700;line-height:1.25;color:#0f172a;">
                Hola, ${safeName}
              </h1>
              <p style="margin:0 0 24px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#475569;">
                Estás a un paso de activar tu cuenta. Pulsa el botón para verificar que este correo es tuyo.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:10px;background:#4f46e5;">
                    <a href="${verifyUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">
                      Verificar mi correo
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.5;color:#64748b;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:
              </p>
              <p style="margin:0 0 24px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;color:#4f46e5;">
                ${verifyUrl}
              </p>
              <hr style="margin:0 0 20px;border:none;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.55;color:#94a3b8;">
                Este enlace caduca en <strong style="color:#64748b;">24 horas</strong>. Si no creaste una cuenta, puedes ignorar este mensaje.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;">
          Mensaje automático · no respondas a este correo
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
      `Hola ${params.username},`,
      '',
      'Verifica tu correo abriendo este enlace (válido 24 horas):',
      verifyUrl,
      '',
      'Si no creaste una cuenta, ignora este mensaje.',
    ].join('\n');

    return { html, text };
  }

  async sendVerificationEmail(params: { email: string; username: string; token: string }) {
    const from = process.env.RESEND_FROM_EMAIL;
    if (!from) {
      AppError.internal(ErrorCode.MAIL_RESEND_NOT_CONFIGURED, 'RESEND_FROM_EMAIL is not configured');
    }

    const appUrl = this.getPublicAppBaseUrl();
    const verifyUrl = `${appUrl}/auth/verify-email?token=${encodeURIComponent(params.token)}`;
    const { html, text } = this.buildVerificationEmailContent({
      username: params.username,
      verifyUrl,
    });

    const result = await this.resend.emails.send({
      from,
      to: params.email,
      subject: 'Verifica tu cuenta',
      html,
      text,
    });

    if (result.error) {
      AppError.internal(
        ErrorCode.MAIL_SEND_FAILED,
        `Failed to send verification email: ${result.error.message}`,
      );
    }

    return result.data;
  }

  async sendMentionEmail(params: {
    toEmail: string;
    toUsername: string;
    fromUsername: string;
    mentionType: 'post_comment' | 'discussion_comment';
    preview: string;
    linkUrl: string;
  }) {
    const from = process.env.RESEND_FROM_EMAIL;
    if (!from) {
      AppError.internal(ErrorCode.MAIL_RESEND_NOT_CONFIGURED, 'RESEND_FROM_EMAIL is not configured');
    }

    const safeFrom = escapeHtml(params.fromUsername);
    const safePreview = escapeHtml(params.preview);

    const typeLabel = params.mentionType === 'post_comment' ? 'publicación' : 'discusión';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Te mencionaron</title>
</head>
<body style="margin:0;padding:0;background-color:#e8ecf4;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#e8ecf4;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);">
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#4338ca 0%,#6366f1 50%,#818cf8 100%);"></td>
          </tr>
          <tr>
            <td style="padding:36px 40px 28px;">
              <p style="margin:0 0 8px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6366f1;">
                Nueva mención
              </p>
              <h1 style="margin:0 0 16px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:24px;font-weight:700;line-height:1.25;color:#0f172a;">
                ${safeFrom} te mencionó
              </h1>
              <p style="margin:0 0 8px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#475569;">
                ${safeFrom} te mencionó en un comentario de ${typeLabel}.
              </p>
              <p style="margin:0 0 24px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#64748b;font-style:italic;">
                "${safePreview}"
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:10px;background:#4f46e5;">
                    <a href="${params.linkUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">
                      Ver comentario
                    </a>
                  </td>
                </tr>
              </table>
              <hr style="margin:0 0 20px;border:none;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.55;color:#94a3b8;">
                Recibiste este email porque tienes las notificaciones por email activadas.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;">
          Mensaje automático · no respondas a este correo
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
      `${params.fromUsername} te mencionó en un comentario de ${typeLabel}.`,
      '',
      `"${params.preview}"`,
      '',
      `Ver comentario: ${params.linkUrl}`,
    ].join('\n');

    const result = await this.resend.emails.send({
      from,
      to: params.toEmail,
      subject: `${params.fromUsername} te mencionó`,
      html,
      text,
    });

    if (result.error) {
      AppError.internal(
        ErrorCode.MAIL_SEND_FAILED,
        `Failed to send mention email: ${result.error.message}`,
      );
    }

    return result.data;
  }
}

