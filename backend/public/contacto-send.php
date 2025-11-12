<?php
// contacto-send.php - lightweight email submit endpoint for DomusGest contact form
// Place in public root (will be deployed to public_html) and POST JSON here.
// If you later move to SMTP/PHPMailer, use contacto-send-smtp.php instead.

declare(strict_types=1);
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

// Allow only POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

// Read JSON body
$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['ok'=>false,'error'=>'Invalid JSON']);
    exit;
}

// Extract + sanitize fields
$name      = trim($data['name']    ?? '');
$email     = trim($data['email']   ?? '');
$subject   = trim($data['subject'] ?? '');
$message   = trim($data['message'] ?? '');
$honeypot  = trim($data['website'] ?? ''); // hidden field must stay empty

// Honeypot triggers silent success (thwarts basic bots)
if ($honeypot !== '') {
    echo json_encode(['ok'=>true,'spam'=>true]);
    exit;
}

// Basic validation
$errors = [];
if ($name === '' || mb_strlen($name) > 100)        $errors[] = 'Nome inválido';
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 150) $errors[] = 'Email inválido';
if ($subject === '' || mb_strlen($subject) > 150)  $errors[] = 'Assunto inválido';
if ($message === '' || mb_strlen($message) > 5000) $errors[] = 'Mensagem inválida';

if ($errors) {
    http_response_code(422);
    echo json_encode(['ok'=>false,'error'=>implode('; ', $errors)]);
    exit;
}

// Simple rate limiting per IP (30s)
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateFile = __DIR__.'/.contact_rate_'.md5($ip);
if (file_exists($rateFile) && (time() - filemtime($rateFile)) < 30) {
    http_response_code(429);
    echo json_encode(['ok'=>false,'error'=>'Espere alguns segundos antes de reenviar']);
    exit;
}
@touch($rateFile);

// Compose email
$to = 'geral@domusgest.net'; // destination mailbox
$finalSubject = '[Contacto Website] '.$subject;
$body = "Nome: $name\nEmail: $email\nIP: $ip\n\nMensagem:\n$message\n";
$headers = [];
$headers[] = 'From: DomusGest Website <no-reply@domusgest.net>'; // ensure this mailbox exists
$headers[] = 'Reply-To: '.$email;
$headers[] = 'MIME-Version: 1.0';
$headers[] = 'Content-Type: text/plain; charset=UTF-8';

$headerStr = implode("\r\n", $headers);
$envelopeSender = '-f no-reply@domusgest.net';
$sent = @mail($to, $finalSubject, $body, $headerStr, $envelopeSender);
if (!$sent) {
    // Fallback attempt using sendmail directly if available
    $fallbackOk = false;
    $sendmailPath = ini_get('sendmail_path');
    if ($sendmailPath) {
        $cmd = $sendmailPath.' -t -i';
        $proc = @popen($cmd, 'w');
        if ($proc) {
            $rawMsg = '';
            $rawMsg .= 'To: '.$to."\n";
            $rawMsg .= 'Subject: '.$finalSubject."\n";
            $rawMsg .= 'From: DomusGest Website <no-reply@domusgest.net>'."\n";
            $rawMsg .= 'Reply-To: '.$email."\n";
            $rawMsg .= "MIME-Version: 1.0\n";
            $rawMsg .= "Content-Type: text/plain; charset=UTF-8\n";
            $rawMsg .= "X-DomusGest-Fallback: 1\n";
            $rawMsg .= "\n".$body; // blank line separates headers from body
            @fwrite($proc, $rawMsg);
            $code = @pclose($proc);
            if ($code === 0) $fallbackOk = true;
        }
    }
    if (!$fallbackOk) {
        // Log failure for diagnostics
        $logLine = '['.date('c').'] IP='.$ip.' email_fail to='.$to.' subject='.str_replace(["\n","\r"],' ',$finalSubject);
        $lastErr = error_get_last();
        if ($lastErr) $logLine .= ' php_error='.preg_replace('/\s+/',' ',$lastErr['message']);
        @file_put_contents(__DIR__.'/contacto-send.log', $logLine."\n", FILE_APPEND);
        http_response_code(500);
        echo json_encode(['ok'=>false,'error'=>'Falha ao enviar email']);
        exit;
    }
}

echo json_encode(['ok'=>true,'method'=>$sent?'mail()':'sendmail']);
