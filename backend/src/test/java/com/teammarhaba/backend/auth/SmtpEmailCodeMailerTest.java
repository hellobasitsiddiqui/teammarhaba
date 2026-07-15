package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.mail.Address;
import jakarta.mail.Message;
import jakarta.mail.internet.MimeMessage;
import jakarta.mail.internet.MimeMultipart;
import java.util.Properties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.LoggerFactory;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * Unit tests for {@link SmtpEmailCodeMailer} (TM-249) with a <strong>mocked</strong>
 * {@link JavaMailSender} (no real SMTP). They assert the message is addressed from/to the right
 * places and that the body carries the code, that blank credentials fail loud at construction, and
 * that a transport failure is surfaced (not swallowed) — without the code ever being logged.
 */
class SmtpEmailCodeMailerTest {

    private static final String EMAIL = "ada@example.com";
    private static final String CODE = "428913";

    private JavaMailSender mailSender;
    private SmtpEmailCodeProperties props;
    private ListAppender<ILoggingEvent> logAppender;
    private Logger mailerLogger;

    @BeforeEach
    void setUp() {
        mailSender = mock(JavaMailSender.class);
        // A real MimeMessage so MimeMessageHelper can populate it and the test can read it back.
        when(mailSender.createMimeMessage())
                .thenReturn(new MimeMessage(jakarta.mail.Session.getInstance(new Properties())));
        // Defaults applied by the record's compact constructor: from = no-reply@10xai.co.uk.
        props = new SmtpEmailCodeProperties(true, null, null);

        // Capture everything the mailer logs so we can assert the recipient email (PII) never leaks.
        mailerLogger = (Logger) LoggerFactory.getLogger(SmtpEmailCodeMailer.class);
        logAppender = new ListAppender<>();
        logAppender.start();
        mailerLogger.addAppender(logAppender);
    }

    @AfterEach
    void detachAppender() {
        if (mailerLogger != null && logAppender != null) {
            mailerLogger.detachAppender(logAppender);
        }
    }

    /** The full text of every captured log event: the formatted message plus any argument tokens. */
    private String capturedLogText() {
        StringBuilder sb = new StringBuilder();
        for (ILoggingEvent event : logAppender.list) {
            sb.append(event.getFormattedMessage()).append('\n');
            for (Object arg : event.getArgumentArray() == null ? new Object[0] : event.getArgumentArray()) {
                sb.append(arg).append('\n');
            }
        }
        return sb.toString();
    }

    private SmtpEmailCodeMailer mailer() {
        return new SmtpEmailCodeMailer(mailSender, props, "no-reply@10xai.co.uk", "app-password");
    }

    @Test
    void sends_withCorrectFromToAndCodeInBody() throws Exception {
        mailer().sendLoginCode(EMAIL, CODE);

        ArgumentCaptor<MimeMessage> sent = ArgumentCaptor.forClass(MimeMessage.class);
        verify(mailSender).send(sent.capture());
        MimeMessage message = sent.getValue();

        // From = the configured (defaulted) sender address.
        Address[] from = message.getFrom();
        assertThat(from).hasSize(1);
        assertThat(from[0].toString()).contains("no-reply@10xai.co.uk");

        // To = the recipient.
        Address[] to = message.getRecipients(Message.RecipientType.TO);
        assertThat(to).hasSize(1);
        assertThat(to[0].toString()).isEqualTo(EMAIL);

        assertThat(message.getSubject()).contains("sign-in code");

        // Both alternatives (plain-text + HTML) carry the 6-digit code.
        String body = extractText(message);
        assertThat(body).contains(CODE);

        // Attribution byline (TM-254): the email footer credits 10xAI and links to the site.
        assertThat(body).contains("A product of 10xAI").contains("10xai.co.uk");
    }

    @Test
    void blankUsername_failsLoudAtConstruction() {
        assertThatThrownBy(() -> new SmtpEmailCodeMailer(mailSender, props, "  ", "app-password"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MAIL_USERNAME");
        verify(mailSender, never()).send(any(MimeMessage.class));
    }

    @Test
    void blankPassword_failsLoudAtConstruction() {
        assertThatThrownBy(() -> new SmtpEmailCodeMailer(mailSender, props, "no-reply@10xai.co.uk", ""))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MAIL_PASSWORD");
    }

    @Test
    void doesNotLogRecipientEmailOnSuccessfulSend() {
        // TM-724: the recipient email is PII and must never appear in any log line on the happy path.
        mailer().sendLoginCode(EMAIL, CODE);

        assertThat(capturedLogText()).doesNotContain(EMAIL);
        // Sanity: a send WAS logged (so this test would still fail if the log line were removed and
        // the email quietly reintroduced elsewhere) — it just doesn't carry the address.
        assertThat(logAppender.list).anyMatch(e -> e.getLevel() == Level.INFO);
    }

    @Test
    void doesNotLogRecipientEmailOnDeliveryFailure() {
        // TM-724: the failure log line must not carry the recipient email (PII) either.
        org.mockito.Mockito.doThrow(new MailSendException("smtp down"))
                .when(mailSender)
                .send(any(MimeMessage.class));

        assertThatThrownBy(() -> mailer().sendLoginCode(EMAIL, CODE))
                .isInstanceOf(EmailCodeDeliveryException.class);

        assertThat(capturedLogText()).doesNotContain(EMAIL);
        assertThat(logAppender.list).anyMatch(e -> e.getLevel() == Level.WARN);
    }

    @Test
    void transportFailure_isSurfacedNotSwallowed() {
        org.mockito.Mockito.doThrow(new MailSendException("smtp down"))
                .when(mailSender)
                .send(any(MimeMessage.class));

        assertThatThrownBy(() -> mailer().sendLoginCode(EMAIL, CODE))
                .isInstanceOf(EmailCodeDeliveryException.class);
    }

    @Test
    void usesConfiguredFromAddressAndName() throws Exception {
        props = new SmtpEmailCodeProperties(true, "alerts@10xai.co.uk", "Marhaba Alerts");

        mailer().sendLoginCode(EMAIL, CODE);

        ArgumentCaptor<MimeMessage> sent = ArgumentCaptor.forClass(MimeMessage.class);
        verify(mailSender).send(sent.capture());
        Address[] from = sent.getValue().getFrom();
        assertThat(from[0].toString()).contains("alerts@10xai.co.uk").contains("Marhaba Alerts");
    }

    /** Recursively flatten the (possibly nested) multipart body to text to assert the code is present. */
    private static String extractText(MimeMessage message) throws Exception {
        StringBuilder sb = new StringBuilder();
        flatten(message.getContent(), sb);
        return sb.toString();
    }

    private static void flatten(Object content, StringBuilder sb) throws Exception {
        if (content instanceof MimeMultipart multipart) {
            for (int i = 0; i < multipart.getCount(); i++) {
                flatten(multipart.getBodyPart(i).getContent(), sb);
            }
        } else {
            sb.append(content);
        }
    }
}
