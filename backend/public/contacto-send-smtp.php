<?php
// contacto-send-smtp.php - PHPMailer/SMTP version (authenticated SMTP)
// Requires PHPMailer via Composer in public_html/vendor

declare(strict_types=1);
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  echo json_encode(['ok'=>false,'error'=>'Method not allowed']);
  exit;
}

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'Invalid JSON']); exit; }

$name    = trim($data['name']    ?? '');
$email   = trim($data['email']   ?? '');
$subject = trim($data['subject'] ?? '');
$message = trim($data['message'] ?? '');
$hp      = trim($data['website'] ?? '');

if ($hp !== '') { echo json_encode(['ok'=>true]); exit; }

$errors = [];
if ($name === '' || mb_strlen($name) > 100)        $errors[] = 'Nome inválido';
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 150) $errors[] = 'Email inválido';
if ($subject === '' || mb_strlen($subject) > 150)  $errors[] = 'Assunto inválido';
if ($message === '' || mb_strlen($message) > 5000) $errors[] = 'Mensagem inválida';
if ($errors) { http_response_code(422); echo json_encode(['ok'=>false,'error'=>implode('; ', $errors)]); exit; }

$to = 'geral@domusgest.net';
$finalSubject = '[Contacto Website] '.$subject;
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$body = "Nome: $name\nEmail: $email\nIP: $ip\n\nMensagem:\n$message\n";

// Load configuration (host, user, pass)
$config = [
  'smtp_host'   => 'mail.domusgest.net',
  'smtp_port'   => 465,
  'smtp_secure' => 'ssl', // 'ssl' for 465, 'tls' for 587
  'smtp_user'   => 'no-reply@domusgest.net',
  'smtp_pass'   => getenv('DOMUSGEST_SMTP_PASSWORD') ?: '',
  'from_email'  => 'no-reply@domusgest.net',
  'from_name'   => 'DomusGest Website',
  'to_email'    => $to,
];
if (file_exists(__DIR__.'/contacto-config.php')) {
  $userCfg = include __DIR__.'/contacto-config.php';
  if (is_array($userCfg)) { $config = array_merge($config, $userCfg); }
}

if (empty($config['smtp_pass'])) {
  http_response_code(500);
  echo json_encode(['ok'=>false,'error'=>'SMTP password not set. Create contacto-config.php with smtp_pass']);
  exit;
}

$autoload = __DIR__.'/vendor/autoload.php';
if (!file_exists($autoload)) {
  http_response_code(500);
  echo json_encode(['ok'=>false,'error'=>'PHPMailer not installed. Run composer require phpmailer/phpmailer']);
  exit;
}
require $autoload;

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

$mail = new PHPMailer(true);
try {
  $mail->CharSet = 'UTF-8';
  $mail->isSMTP();
  $mail->Host = $config['smtp_host'];
  $mail->SMTPAuth = true;
  $mail->Username = $config['smtp_user'];
  $mail->Password = $config['smtp_pass'];
  if (($config['smtp_secure'] === 'ssl') || (int)$config['smtp_port'] === 465) {
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
    $mail->Port = 465;
  } else {
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port = 587;
  }

  $mail->setFrom($config['from_email'], $config['from_name']);
  $mail->addAddress($config['to_email']);
  if ($email) $mail->addReplyTo($email, $name ?: $email);
  $mail->Subject = $finalSubject;
  $mail->Body    = $body;
  $mail->AltBody = $body;

  $mail->send();
  echo json_encode(['ok'=>true,'method'=>'smtp']);
} catch (Exception $e) {
  // Log minimal error info to file
  $log = '['.date('c').'] smtp_error '.$e->getMessage();
  @file_put_contents(__DIR__.'/contacto-send.log', $log."\n", FILE_APPEND);
  http_response_code(500);
  echo json_encode(['ok'=>false,'error'=>'SMTP falhou']);
}
