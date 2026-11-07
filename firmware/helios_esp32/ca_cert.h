#pragma once
// Paste the root CA certificate of YOUR EMQX Cloud Serverless deployment here.
// Download it from the EMQX Cloud deployment overview (TLS/SSL certificate).
// Never invent or hardcode a certificate: TLS verification must use the actual
// issuer of your broker. Keep this file out of source control if your policy
// treats certificates as sensitive.
//
// Example shape (replace entirely):
// const char *helios_root_ca = R"EOF(
// -----BEGIN CERTIFICATE-----
// ...your broker CA in PEM format...
// -----END CERTIFICATE-----
// )EOF";

extern const char *helios_root_ca;
