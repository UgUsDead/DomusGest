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

$sent = @mail($to, $finalSubject, $body, implode("\r\n", $headers));
if (!$sent) {
    http_response_code(500);
    echo json_encode(['ok'=>false,'error'=>'Falha ao enviar email']);
    exit;
}

echo json_encode(['ok'=>true]);
