<?php
// Copy this file to contacto-config.php in the same folder and fill in your SMTP password.
return [
  // SMTP server provided by cPanel for your domain
  'smtp_host'   => 'mail.domusgest.net',
  // Use 465 with 'ssl' OR 587 with 'tls'
  'smtp_port'   => 465,
  'smtp_secure' => 'ssl',

  // Mailbox that sends messages
  'smtp_user'   => 'no-reply@domusgest.net',
  'smtp_pass'   => 'CHANGE_ME',

  // Envelope/addresses
  'from_email'  => 'no-reply@domusgest.net',
  'from_name'   => 'DomusGest Website',
  'to_email'    => 'geral@domusgest.net',
];
