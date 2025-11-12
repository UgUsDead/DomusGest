<?php
// contacto-send-smtp.php - PHPMailer/SMTP version (use when you want authenticated SMTP)
// Requires PHPMailer library (can be installed via Composer or placed manually).

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

// ---- Configure PHPMailer ----
// If installed via Composer: require __DIR__.'/vendor/autoload.php';
// Otherwise include the PHPMailer classes manually.

// Example using Composer path (adjust if different):
// require __DIR__.'/vendor/autoload.php';
// use PHPMailer\PHPMailer\PHPMailer; use PHPMailer\PHPMailer\Exception;

// $mail = new PHPMailer(true);
// try {
//   $mail->isSMTP();
//   $mail->Host = 'localhost';            // or your provider SMTP host
//   $mail->SMTPAuth = true;
//   $mail->Username = 'no-reply@domusgest.net';
//   $mail->Password = 'YOUR_PASSWORD';
//   $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS; // or SSL
//   $mail->Port = 587;                    // 465 for SSL, 587 for STARTTLS
//
//   $mail->setFrom('no-reply@domusgest.net', 'DomusGest Website');
//   $mail->addAddress($to);
//   $mail->addReplyTo($email, $name);
//   $mail->Subject = $finalSubject;
//   $mail->Body    = $body;
//   $mail->AltBody = $body;
//
//   $mail->send();
//   echo json_encode(['ok'=>true]);
// } catch (Exception $e) {
//   http_response_code(500);
//   echo json_encode(['ok'=>false,'error'=>'SMTP falhou']);
// }

echo json_encode(['ok'=>false,'error'=>'PHPMailer não configurado. Use contacto-send.php ou conclua a configuração SMTP.']);
