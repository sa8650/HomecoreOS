#pragma once
/**
 * Trust anchor for the HomecoreOS API origin (Cloudflare Pages).
 *
 * Taken from the live TLS chain of https://homecoreos.pages.dev and therefore
 * Let's Encrypt, not the EMQX/DigiCert chain. The PEM body is injected at build
 * time by scripts/build-firmware.mjs so this file stays readable and the
 * certificate is easy to rotate: replace it in Cloudflare and re-run the build.
 *
 * Contents: ISRG Root YE (cross-signed) and ISRG Root X2, which terminate the
 * chain served today. Renewal keeps the same roots.
 */
#define HOMECOREOS_API_CA_FALLBACK ""

#ifndef HOMECOREOS_CA_API_PEM
#  define HOMECOREOS_CA_API_PEM HOMECOREOS_API_CA_FALLBACK
#endif
