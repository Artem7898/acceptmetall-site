import { createOrderClient } from './order-client.mjs';

const messages = {
  ru: {
    pending: 'Сохраняем заявку…',
    received: id => `Заявка сохранена. Номер: ${id}. Сохраните этот номер для обращения к менеджеру.`,
    failed: 'Не удалось подтвердить приём заявки. Данные сохранены в форме. Повторите отправку или позвоните: +7 (904) 551-17-63.',
    rate: 'Слишком много попыток. Подождите несколько минут и повторите отправку. Данные остались в форме.',
    file: 'Прикрепите один файл PDF, JPG или PNG размером до 5 МБ.',
    invalid: 'Проверьте поля и вложение. Заявка не подтверждена, данные остались в форме.',
    secure: 'Для отправки откройте сайт по HTTPS в современном браузере или позвоните: +7 (904) 551-17-63.',
  },
  en: {
    pending: 'Saving your request…',
    received: id => `Your request has been saved. Reference: ${id}. Keep this reference when contacting our team.`,
    failed: 'We could not confirm receipt. Your details remain in the form. Try again or call +7 (904) 551-17-63.',
    rate: 'Too many attempts. Wait a few minutes and try again. Your details remain in the form.',
    file: 'Attach one PDF, JPG or PNG file up to 5 MB.',
    invalid: 'Check your fields and attachment. Receipt has not been confirmed; your details remain in the form.',
    secure: 'Open this site over HTTPS in a modern browser to submit, or call +7 (904) 551-17-63.',
  },
};

export function initOrderForms() {
  for (const form of document.querySelectorAll('form[data-order-form]')) {
    if (form.dataset.initialized) continue;
    form.dataset.initialized = 'yes';
    const text = messages[form.dataset.lang] || messages.en;
    const fields = form.querySelector('[data-order-fields]');
    const button = form.querySelector('[data-order-submit]');
    const errorMessage = form.querySelector('[data-order-error]');
    const result = document.querySelector(`[data-order-result="${form.id}"]`);
    const originalLabel = button.textContent;
    const client = createOrderClient({ endpoint: form.action });
    let busy = false;

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      const data = new FormData(form);
      busy = true;
      fields.disabled = true;
      button.textContent = text.pending;
      form.setAttribute('aria-busy', 'true');
      errorMessage.hidden = true;
      result.hidden = true;
      try {
        const orderId = await client.submit(data);
        result.textContent = text.received(orderId);
        result.hidden = false;
        form.hidden = true;
        result.focus();
      } catch (error) {
        errorMessage.textContent = ['invalid_file', 'file_too_large'].includes(error.code) ? text.file
          : error.status === 429 ? text.rate
          : [400, 413, 415, 422].includes(error.status) ? text.invalid : text.failed;
        errorMessage.hidden = false;
      } finally {
        busy = false;
        fields.disabled = false;
        button.textContent = originalLabel;
        form.removeAttribute('aria-busy');
      }
    });
    if (globalThis.crypto?.randomUUID && globalThis.crypto?.subtle) fields.disabled = false;
    else {
      errorMessage.textContent = text.secure;
      errorMessage.hidden = false;
    }
  }
}
