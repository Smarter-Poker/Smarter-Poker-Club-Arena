/**
 * LAW: optimizing dist media is parallel, cached, and safe to run twice.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. `scripts/optimize-dist-media.mjs` was 88.0s of a 266s CI
 * build and 85.7s of a 120s publisher build, and it runs THREE times per
 * merge - the second largest item on the push-to-live critical path. Two
 * things were wrong with it:
 *
 *  1. SERIAL. One `await pipeline.toFile()` at a time, 496 candidates, on a
 *     16-core box.
 *  2. NO MEMORY, AND NOT IDEMPOTENT. Every raster in dist/ is a byte-for-byte
 *     copy of a committed source asset, so the same input was decoded and
 *     re-encoded on every build of every branch forever. Worse, a second pass
 *     over an already-optimized dist "optimized" 90 more files - generational
 *     quality loss, silently, for anyone who restored a warm dist.
 *
 * This test is behavioural, not textual: it builds a synthetic dist/, runs the
 * real script against it twice, and asserts what the pipeline depends on.
 *
 * THE ONE WAY THIS CACHE CAN SERVE STALE BYTES is a change to the encoder
 * settings without a bump to ENCODER_SETTINGS_VERSION, so that is pinned by
 * name here: the constant sits directly above the settings it covers, and if
 * you changed one you must change the other.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { viteMediaIdentity } from '../scripts/optimize-dist-media.mjs';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'optimize-dist-media.mjs');

// Permanent public URLs: sealed 29aa/run34836323037 bytes, with five new
// assets from sealed 5305/run35070339226. New artwork must use a new URL.
const SEALED_PUBLIC_ASSET_BYTES: Readonly<Record<string, string>> = {
  'assets/ads/bbj-running-hub-promotions-v1.webp':
    '76323b90264ca9f7687caad16f6d2a6bbffb735e66f295d67e61c55939974441',
  'assets/ads/bbj-running-lobby-strip-v1.webp':
    '52bc875ffb3880f776064d57d13284b7e6fe4b515c025d0c08bd94621c0cb305',
  'assets/ads/bbj-running-poster-v1.webp':
    'ae5fd2ab112c78330048cbde06d1b5fd80932cc24a5a8ec19eeb77c5b8b78621',
  'assets/ads/bbj-running-session-summary-v1.webp':
    '24763d8aabdefb533195584586a538497faea43564613c5852c8d6dba9260723',
  'assets/ads/diamonds-store-hub-promotions-v1.webp':
    '0662e86c8789e1c25045e06830a49ff9c11478cf5ec7fede116d3b87d1a33b58',
  'assets/ads/diamonds-store-lobby-strip-v1.webp':
    '8762c623c69361e37e354a21cffcc4c47a5dd16433c406520c060034c0ffcf44',
  'assets/ads/diamonds-store-poster-v1.webp':
    '7ad97ed92961857d3585a70e6f58c4ff9db02c18ea329df81b486356c74e0c11',
  'assets/ads/diamonds-store-session-summary-v1.webp':
    '2cc3fa5a3496731a115741f9bb0ac7555a3e4e0f1579664d6f629963edbb640f',
  'assets/ads/referral-invite-hub-promotions-v1.webp':
    '810c8824d5e9d3ebc2a46059efba82502a685f644a6edd1316e0012592499e3b',
  'assets/ads/referral-invite-lobby-strip-v1.webp':
    '8c9fe9cf75efe5b6ee2d6700037b93b1a2042f3cee1947197491681b56556ef1',
  'assets/ads/referral-invite-poster-v1.webp':
    'cd1445a6915fdcd290791aa24c3ba1b8035963902bdb58de0dfaad784a258808',
  'assets/ads/referral-invite-session-summary-v1.webp':
    '2e37bdbee14a311faefcdae2e5c77fd4559e648a7a1591670528de9944265ede',
  'assets/ads/spins-jackpot-hub-promotions-v1.webp':
    'b7e14c4f50b206d9291433ea5a622ab0864c57df21734a2034761b0e4bdeb5cf',
  'assets/ads/spins-jackpot-lobby-strip-v1.webp':
    'edbb6564f87bf36bd72bd304af7860cc25d7d44d59e39c63cc55c7c593d2bf16',
  'assets/ads/spins-jackpot-poster-v1.webp':
    '2f4b547dc759682158ab3e4a1256fff429a768a008fd1026d1f0232cca77ec1b',
  'assets/ads/spins-jackpot-session-summary-v1.webp':
    '4a2c36d17c27c7ee298b84732a584a246bf7a4a6432b3f1f4ad5f48954e01cae',
  'assets/ads/tournaments-daily-hub-promotions-v1.webp':
    'abd5875d796a4bccab0c262ce1f242ea425ddf1c7826190011d6d9dd45b50ded',
  'assets/ads/tournaments-daily-lobby-strip-v1.webp':
    'ccc87d0b7b1040a9ab29dbf05cd17e01600fb4a70396cdffb66c29e2333b7db7',
  'assets/ads/tournaments-daily-poster-v1.webp':
    'e8b1391d190456d7e8cf33e3b4cbe4f53c0b500e011870afeccdd46443277640',
  'assets/ads/tournaments-daily-session-summary-v1.webp':
    'd803189f9ce3f68215a3f61efc0f93485f283e54f085cbb27a4202fe9a0431da',
  'assets/ads/vip-upsell-hub-promotions-v1.webp':
    '06329a519ccc5450e2e2333c92eb165b2a794f1889ce9ddac41de4c6eb78344b',
  'assets/ads/vip-upsell-lobby-strip-v1.webp':
    '731452bc030d7f4e1d19d7ae55c2442a17fc6358e5595c7bdf31e89177d694f0',
  'assets/ads/vip-upsell-poster-v1.webp':
    'b108fa2df76b9fa0ff9c5beb6aa0ac4f6e699add59beb2d39a4a49c27e79da55',
  'assets/ads/vip-upsell-session-summary-v1.webp':
    'dde77e3601ea925e45a0b0e5a0c47136c100b9414dd2a25a955665e444380af5',
  'assets/club-buttons/action-primary-shell.png':
    'da7d7947a9612de8b677a84106e77b6b68ce273394ced403e25613aa1f157ecc',
  'assets/club-buttons/action-primary-shell.webp':
    '2e75ea23598a1189f7f4cefb4b2b455f39ede442ecd53682524dfbece5f2263b',
  'assets/club-buttons/bbj/bbj-dynamic-plaque-v1.png':
    '11602fd1e8a45c11b1a68efde076bc28bc9f1e6c0d32d3555fc7956b470e90bc',
  'assets/club-buttons/bbj/bbj-dynamic-plaque-v1.webp':
    '02fb6266aeff4347eadfa69959d7aada3411c0fb5591f7934683e39eb58a7aff',
  'assets/club-buttons/club-nav-shell.png':
    'fc0e28e4b302d98f0fac738fbf2e36f92c80f1fe569128673b0d540af05b1b09',
  'assets/club-buttons/club-nav-shell.webp':
    '2f32f48b45c83374777c2658086dbd671e117fbb37ca1c7acd448ac9d580dbcd',
  'assets/club-buttons/club-utility-shell.png':
    '151ca8c141e39f7f03535cbc1ec21e54e60e994b04fb7c648c5d975ff918fc2c',
  'assets/club-buttons/club-utility-shell.webp':
    'dec80e4b4aa0fd179144de4aba492091fd71ecde57a61a144f81f159af9409ac',
  'assets/club-buttons/club/club-identity-icon-club-v1.png':
    'b4d4374daadd2cb9b22512cba8a12de05577ffcfba7b80de0f3bea63673ea56a',
  'assets/club-buttons/club/club-identity-icon-player-v1.png':
    '44e01ae984042c622c231632322a07d2a84b7c673d415534653499d2a4fe66c8',
  'assets/club-buttons/club/club-identity-template-bbj-finish-v1.png':
    '2db6fc692c87d7f655f2bb6caa617cb62284a5448aab2e2cb191026c2bb37d19',
  'assets/club-buttons/club/club-identity-template-no-level-v2.png':
    '504b1913a80c5c77dd656b683f42a3711539dd935c030e0d0f0e88ef9b4bf4d7',
  'assets/club-buttons/club/club-identity-template-no-level-v3.png':
    '3ab34215cb2373f9d8c98611f0bec826d0d2b4d5e91139a857da7a312dbaa893',
  'assets/club-buttons/club/club-identity-template-no-level-v4.png':
    'c4fa423a9850f10977124001c1e09fe6cad39fdc84e2630abf560fcd68195941',
  'assets/club-buttons/club/club-identity-template-no-level-v5.png':
    '7d16f9a98e5cde74bb495611328bd5cec8411fdb61e645462173daaa008946e4',
  'assets/club-buttons/club/club-identity-template-no-level-v6.png':
    '76930ed156bc69f54cc9d1b2efc395b2c1feb6cf69f62791ee2385f401fc730a',
  'assets/club-buttons/club/kingfish-v1/chassis.png':
    'dc5170185f051870cd32f3c79ae719b0d8024836ac157c474238130bce34a879',
  'assets/club-buttons/club/kingfish-v1/source/approved-reference.jpg':
    'b14ab0aa333f266c7898134dd7b50203342a8ecf9aed31dd856174815b4e85ae',
  'assets/club-buttons/console/riveted-console-v1/bottom.png':
    '30b448c6b422077aa9b1baad72dfc3a05891d1e10ac830da5d78eef94681f1eb',
  'assets/club-buttons/console/riveted-console-v1/mid.png':
    '3a167b0f63161ba133e795184233c6c281609e96b70a5e1aa0b02adce1e73d50',
  'assets/club-buttons/console/riveted-console-v1/top.png':
    '124081ee7ec50d6aa299390e3f96fda8c005e1fe053aba688d503123acdc738f',
  'assets/club-buttons/console/shark-console-v1/bottom-plate.png':
    '1851fa6b356a71e76f1df74bb51698b97eea9a8a615b170e47212c1d76249bd1',
  'assets/club-buttons/console/shark-console-v1/mid.png':
    '1d7efadd41691ea8b4eca1de784ba185c24260fca9d2b6eaec469671143115b5',
  'assets/club-buttons/console/shark-console-v1/top.png':
    'eb92f01f6e8848313ee187640235f92cd9a8100cbd346dcc818591f069c888b9',
  'assets/club-buttons/console/spade-console-v1/bottom-foot.png':
    'db0e738eff21ed434e3c6823fe28c276dbb3f28948de96a3812d9fdf308d3d0f',
  'assets/club-buttons/console/spade-console-v1/bottom-plates.png':
    '68311dfb323f023f8ec322fbf8e64d60548c33b4bd63f61f8d5656c65dbd4957',
  'assets/club-buttons/console/spade-console-v1/mid.png':
    '3643e1688ff20e0383d8c14acf17e848731765b8fd38f69af5afa4d57e4fa6e3',
  'assets/club-buttons/console/spade-console-v1/source/README.md':
    '9d3e7d32ab9229c20018e6a084d7932bf4f948cdbb3684b82a29da3048714f18',
  'assets/club-buttons/console/spade-console-v1/source/crest-club.png':
    '15c563ea1f9e45bc686e78ea27b86bac4446316a73c31a22856540382555203a',
  'assets/club-buttons/console/spade-console-v1/source/crest-diamond.png':
    '656d18fdcbc2619f5970e0df252464bd0996e0863355efaa66f6a68b0e56b182',
  'assets/club-buttons/console/spade-console-v1/source/crest-vip.png':
    '195264e6007882c36fe0d90b9eec421548901affee6d266c7a61c9b14bcbfe5b',
  'assets/club-buttons/console/spade-console-v1/top-club.png':
    'e0c503daf898b21e228ee24c935001b84c1540f6f5588f7f8bfd23b57861849b',
  'assets/club-buttons/console/spade-console-v1/top-diamond.png':
    'd0d9b42c039842028d2405a2c5e10e15332d2cd2ebf301f92ab1fa6b9b11818f',
  'assets/club-buttons/console/spade-console-v1/top-flat.png':
    '394a32af66be7c269e7b73454224e60b2e6e110f4b2195f9e90982c334d032c8',
  'assets/club-buttons/console/spade-console-v1/top-vip.png':
    'c4911fe3e10f94e242d9f52d411fb66932f6a5d7dcceb618aaa7ef7713930e4c',
  'assets/club-buttons/console/spade-console-v1/top.png':
    '22232d0ecb66449d4d58d7253f51b33abf22b3b4c8fcd4d681d017a865fd01bc',
  'assets/club-buttons/game-cards/heads-up/desktop.png':
    'a76405ed89193cd7a1a3bd16f411dca2f0ebf6ee1aea26c06b1caca7f5d77cdf',
  'assets/club-buttons/game-cards/heads-up/mobile.png':
    '8785637aad1898aed19a4fe10fef7e84257db497d61d2a23ded5af5f79f3266b',
  'assets/club-buttons/game-cards/heads-up/shark-headsup-premium-v1/chassis.png':
    '494d16085e243112bf4a4bbf7d4e67bb091705f84df2ce05542e177a30f6b675',
  'assets/club-buttons/game-cards/heads-up/shark-headsup-premium-v1/source/approved-reference.png':
    'a76405ed89193cd7a1a3bd16f411dca2f0ebf6ee1aea26c06b1caca7f5d77cdf',
  'assets/club-buttons/game-cards/heads-up/shell-desktop-v2.png':
    'a1b695a0550d4c183f184f2967569f2b6ab18a72557fc535dc4aff9c9eacded5',
  'assets/club-buttons/game-cards/heads-up/shell-desktop-v2.webp':
    '0f698317232ddb84014d19477dfef8e09a7453d94bf341071d835302e74e9be6',
  'assets/club-buttons/game-cards/heads-up/shell-mobile-v2.png':
    'd79972a7254d9c06caf44b77de1356108aff8a33e67967d8bb864d8669bb794a',
  'assets/club-buttons/game-cards/heads-up/shell-mobile-v2.webp':
    'ed1faa758d4a6a00a9ac68c17849594b44e85ba7d67ad36b48ceab3b7cde6ea5',
  'assets/club-buttons/game-cards/heads-up/shell-mobile-v4-reference-clean.png':
    '737c8f54c59a099cd888e7aa652f75e8716049eeee80abcf6c4f4cd5a683af80',
  'assets/club-buttons/game-cards/mtt/desktop.png':
    'd8fd597368c113bc075dcba5e4dfa4717f04cc43c427436422aaea42ee88aa3d',
  'assets/club-buttons/game-cards/mtt/mobile.png':
    'd93445395bc1b4ffedcdf90fa363d24a807a4edcc320bd478035420492169139',
  'assets/club-buttons/game-cards/mtt/shell-desktop-v2.png':
    '6051fa1a419c2a9bdbf25c18390b3fdb7c4a249b425ceafa54f3a2a626c6e060',
  'assets/club-buttons/game-cards/mtt/shell-desktop-v2.webp':
    'eb6060e0e585cc64961679e37e3360016cacaa853ff0c8d7be265ec9763b225d',
  'assets/club-buttons/game-cards/mtt/shell-mobile-v2.png':
    'e258e18226986ea50090957462a6b75d83cd07fd5670a353e06bc67a88b3607e',
  'assets/club-buttons/game-cards/mtt/shell-mobile-v2.webp':
    'e944cdf606108faf12c117761e797c2d646d4eff8285bdce05ef5ead322bf349',
  'assets/club-buttons/game-cards/mtt/shell-mobile-v4-reference-clean.png':
    'ada60661d712aa5b6cc5f83334ccaa9dbd6018ef5e0fd1c415d1a5afd53266f7',
  'assets/club-buttons/game-cards/nlh/desktop.png':
    'ac318816a592afdf8a5604ba375ebbeedc0ec78095abc1ee106fee346d20d75f',
  'assets/club-buttons/game-cards/nlh/mobile.png':
    'ca90ab4d79bb380224671e0b69ebe5c79b65af87a62500f88e74adfac3a632be',
  'assets/club-buttons/game-cards/nlh/shell-desktop-v2.png':
    '964d0eb95ea9876e9e3f82a183455aecdb005a9421a3c17e389d8d71c4b9e051',
  'assets/club-buttons/game-cards/nlh/shell-desktop-v2.webp':
    '6995c15e0a6828e065bf1ae2b613ea64eef2b19d90432de93ce2527e6641acb7',
  'assets/club-buttons/game-cards/nlh/shell-mobile-v2.png':
    'dc6726453bd2adabe267bad58e96036559b0eba626c166edb86658e40bcd6a16',
  'assets/club-buttons/game-cards/nlh/shell-mobile-v2.webp':
    'c706212218a6b67c9e7920cc1b07cf0d9e6773033860c56e7a53aa44eeb3e9c9',
  'assets/club-buttons/game-cards/nlh/shell-mobile-v4-reference-clean.png':
    'e762762a6b2576dab84f27c545857ce105863e22692f9851817b0f4dc0a99c3f',
  'assets/club-buttons/game-cards/nlh/shell-mobile-v4-tall-reference.png':
    'd858e4fb990d32c8b42cf33443d933f9a424c60d0879df5f2e3ce77398584510',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/join-plate.png':
    'a757504077213aaa88a852e255c421d45d8e2ff60a7567e382bebc732e2816c6',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/join-table.png':
    '01af1f8b0196617b697afebe29c1d65aa8dd352c86ff9d223af49a5c70ba7556',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/view-plate-10e21c24e5d6.png':
    '10e21c24e5d628c00b6b7f2d2cbc487a087fce7c8f218352245922d59c1d7b72',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/view-table.png':
    'cc2b3d9a213b38dbc975df58a5613dd4f57ae6302ca40588e3655d6fc6fd3139',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/chassis.png':
    '42ae3ec7c8c8ef0766b258934ab4ae896c8782d28578258c56e41b2abd10aa08',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/source/approved-reference.png':
    'a72a2778d8ea0b9125ca93652fb45d0e0b09688db02faf8392a2dbc164b3961a',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/source/restoration-mask.png':
    'b65327653271c8fe5f85f155d854fbb67663cf5df24084a81e5496c1c600c2b9',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/statuses/live-dot.png':
    '64b70867d7f3d934298ce74ad9a8bcdf105e3eb87e1ce0b68a28dc9ae392bf0c',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/statuses/running.png':
    '159f2823fed19566ef5b62694b63a69c845f8e6e3d50c6f35cc3a37db0d59f37',
  'assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/types/nlh.png':
    '7fb3b74aa8d19ad5beaa9c6bb8d262ad7b9029ab45a2c6e2d756b6686d382818',
  'assets/club-buttons/game-cards/plo/desktop.png':
    'a32a0c0f1685d256ac878a0bf5e9898ff933834c55f0ab1508a8fe913e264168',
  'assets/club-buttons/game-cards/plo/mobile.png':
    '55ea59d5f1e9e3f129a5c360266965eb0a929e213def3982b688e51a3dab1491',
  'assets/club-buttons/game-cards/plo/shark-four-bay-v1/chassis.png':
    '7d3853afed06a610aaf2cf1a57db9f8d4894dc3de28520aa6b6889d868343499',
  'assets/club-buttons/game-cards/plo/shark-four-bay-v1/live-dot.png':
    'a85dcbf9c42704bb1eb0b22c448db8e9b5fe7b24000016320d08593f6c44ebd1',
  'assets/club-buttons/game-cards/plo/shark-four-bay-v1/source/approved-reference.png':
    'e762762a6b2576dab84f27c545857ce105863e22692f9851817b0f4dc0a99c3f',
  'assets/club-buttons/game-cards/plo/shell-desktop-v2.png':
    '7813ef9bb57a7c57dbf3a95c6cc1e37a9017970dc583897e90deecc68b25fa06',
  'assets/club-buttons/game-cards/plo/shell-desktop-v2.webp':
    'da6078426ce7315e58118d9ea351206c347d8432bc5d0ae38ea8ec7af71f22c1',
  'assets/club-buttons/game-cards/plo/shell-mobile-v2.png':
    '7c5bbbf1abe44b9cc3bcca91f9f4c2e285f7110dc0e47a62c40035cfa96b3571',
  'assets/club-buttons/game-cards/plo/shell-mobile-v2.webp':
    'fd939565f30e3e53133a71a8551a3704138485609ddfc20692b44521578d7d08',
  'assets/club-buttons/game-cards/plo/shell-mobile-v4-reference-clean.png':
    'ac7d86ba8dfcc5787e566f14dce4fd92868d308df568c63a059c7deba59d48f1',
  'assets/club-buttons/game-cards/plo/spade-plo-premium-v1/chassis-b0b05b302c99.png':
    '460b8a9858ce5601e32d6ba20789bd0d48fedd9f0798f3f1aee561369424b4b2',
  'assets/club-buttons/game-cards/plo/spade-plo-premium-v1/chassis.png':
    '9411a09e2a61040170b87300652239013677ffe75ec26f77d110d235372e8eb3',
  'assets/club-buttons/game-cards/plo/spade-plo-premium-v1/source/approved-reference.png':
    '95fc6f21d975236eadb5a111ca5e1a7ec38ab5f43399be59ac387cebf41c28e7',
  'assets/club-buttons/game-cards/spins/desktop.png':
    'ba3e31271bb67f693793d73404b3e4c7cfbd787ddd9802904cdbe9a0930418a7',
  'assets/club-buttons/game-cards/spins/mobile.png':
    '8bb41febca595b0b8e8d319f89e423605eafc139554bb40e7591dd08df1fde00',
  'assets/club-buttons/game-cards/spins/shark-spins-premium-v1/chassis.png':
    'a5f30ae94609f7a28556e59692a592800dbc707119905d1850e9cf3a2fad7cf0',
  'assets/club-buttons/game-cards/spins/shark-spins-premium-v1/source/approved-reference.png':
    'ba3e31271bb67f693793d73404b3e4c7cfbd787ddd9802904cdbe9a0930418a7',
  'assets/club-buttons/game-cards/spins/shell-desktop-v2.png':
    '6818668882287b403579cc42d525e3cca92862d6e3c94adecc597624c10d8070',
  'assets/club-buttons/game-cards/spins/shell-desktop-v2.webp':
    'd2a142c1ddd7f8566bef0228ea9c7210b799e80057a2a398c012883f69ed36e5',
  'assets/club-buttons/game-cards/spins/shell-mobile-v2.png':
    '84956c5c6f4b8539d89d734d853a6b70df79632f92918ad155c96afcca285602',
  'assets/club-buttons/game-cards/spins/shell-mobile-v2.webp':
    'dd1687ee589d93c448a161232f0d53c6de0da4f3ad161cca7b96c53db59862bd',
  'assets/club-buttons/game-cards/spins/shell-mobile-v4-reference-clean.png':
    '4acbb0e5c2556d1ee80e826298981434d824d6ccfb642dc3cf0092e778d9ee1b',
  'assets/club-buttons/jackpot-hero-shell.png':
    '94dc3e3bef3baa2c5b36c887b4c3ad79f934d9eb628336975eb5b5bdbad1b5b5',
  'assets/club-buttons/jackpot-hero-shell.webp':
    '89bb0c899d22064996593cfb44d2f11945a8af4848092ee1d74cb2f349369ba9',
  'assets/club-buttons/lobby/lobby-approved-desktop-reference-v3.png':
    '67e651f953dbf131e8451d066a259d46184277be5a46872dc70ae8f51b9361df',
  'assets/club-buttons/lobby/lobby-campaign-frame-v3.png':
    'c80ea0a82ed9f45f1576050c53361077d882fcc8eefff40738dc858924ab700c',
  'assets/club-buttons/lobby/lobby-command-chassis-v2.png':
    '1ae8958e3746fca5991a7133f1c182939f482a40063d7f4eb0345a003d4ecdee',
  'assets/club-buttons/lobby/lobby-controls-frame-v3.png':
    'ebf50a7da7dde92419d368896009a92890ca584c074927c86f948c5c2b7419a5',
  'assets/club-buttons/lobby/lobby-filter-default-v3.png':
    'a8ba25095aebefa500f7cab4a79a79c1959a60e8d69ea0769e49b1dc2c5bfed0',
  'assets/club-buttons/lobby/lobby-header-frame-universal-v4.png':
    '8ef364ec877181577b6b07881d6e21019330340f37cb6212c62dfe61dd2d331b',
  'assets/club-buttons/lobby/lobby-header-frame-v3.png':
    '024a43f3b4f0e93d3fa0ba1a6d3e13c1429260007721b119ca018f7ef47d6e0f',
  'assets/club-buttons/lobby/lobby-preference-active-v3.png':
    '86b8ddf559b9f09a63df6ba5b5a85b266d1f8a849b312b0cc21d84e602cc7f3e',
  'assets/club-buttons/lobby/lobby-preference-default-v3.png':
    'c9b8d86216eaae865691fcdc4213414239677929372ae7a19e841cff0223f9f3',
  'assets/club-buttons/lobby/lobby-selector-active-v3.png':
    '484a7caed845caac3793d8c85b5649294f502e1046610cd1b4a895cd8083b3ba',
  'assets/club-buttons/lobby/lobby-selector-default-v3.png':
    '4f38d7173d7d785a73317c52ce9df9ea7f9c95b497d4a11df8777d3965091c3d',
  'assets/club-buttons/lobby/shark-club-championship-ad-mobile-v4.png':
    'bcb2becd08df6dcef27e4e8f3cf55dd8a80e77a42c828c702db2280eaf85af33',
  'assets/club-buttons/lobby/shark-club-championship-ad-v2.png':
    '934ff16ae1249a8177e01dcc40eeb6b8e9dfaf6fbe706bc9beb685bb0651ecd5',
  'assets/club-buttons/lobby/shark-panel-v1/bay.png':
    'f20d1fbfa707da47160f6a5222740b423963751a86f3fb2fce53bfe3b7886906',
  'assets/club-buttons/lobby/shark-panel-v1/bottom.png':
    '317ae3714b9ff8bc551d316c1c87f74ec2cbd8f9210aff185b968c0ea08a3cf1',
  'assets/club-buttons/lobby/shark-panel-v1/button-primary.png':
    '3d8d8660d46ab7e43e97224aa6461571108a395bd5cb7e1966d76984ae180d7b',
  'assets/club-buttons/lobby/shark-panel-v1/button-secondary.png':
    '05b176b8074275338add68cdaa44fff2f5ad622c60a9eac26c72a95ef036886f',
  'assets/club-buttons/lobby/shark-panel-v1/mid.png':
    '1aa104a2ee157ac4392ba084ff17e56ca5bb2a933ca0e0c5895d8f143bf07f5e',
  'assets/club-buttons/lobby/shark-panel-v1/top.png':
    '36f29b5d01fa5163a40c143edecb2eaa178fdb2f62a6a3eb81a508ca34de884f',
  'assets/club-buttons/popups/buy-in-v1/deck-d5664b815000.png':
    'd5664b8150009134494edd6ad5e3986dd31ba375f9c1848da4e4c576f4c4f5c5',
  'assets/club-buttons/popups/buy-in-v1/source/approved-reference-37716019dbbf.png':
    '36aaa95d0c8256b5af7626e7295c60d86f18a4403c40ed9c27f8944b5e3d1b85',
  'assets/club-buttons/table-management/command-rail-v1/README.md':
    '6fa732cf8bcfdc376f8f8ea6f6741ab99229fe22110298bd01457a201a6b7a48',
  'assets/club-buttons/table-management/command-rail-v1/chassis.png':
    '28f6ea07b14e0ae51ed224feb9fa2d0e67d227ceb21fd5f73cece80ab6944a17',
  'assets/club-buttons/wallet-row-shell.png':
    'eda8a07f19b2bbb0a9e53058c0465b4912ea2d58145733324f531ab06c3f70d1',
  'assets/club-buttons/wallet-row-shell.webp':
    '90193a0474792ac3329057c780a9d346bc9fef7053d1015baa5fa09838342124',
  'assets/club-buttons/wallets/desktop/wallet-agent-wallet-v1.webp':
    '5f65106b4d0e9b6887787deabaeaecd11dcbc78f6c97b0e7770c2370e4a16f76',
  'assets/club-buttons/wallets/desktop/wallet-backup-bbj-wallet-v1.webp':
    'b062621e00d1b808bb689f068d5f8abf621e7f9064fb1d089b1ede4605123fd9',
  'assets/club-buttons/wallets/desktop/wallet-club-bank-v1.webp':
    'c94cd485dcae3a11a4a8766ba114ca6b8094a5616fb6a1ca705f572c06c15643',
  'assets/club-buttons/wallets/desktop/wallet-diamonds-v1.webp':
    '41b9af6fb306f66f4d6cd2870d4961283cf1cd20e31445a99cad1a8b5ab058e2',
  'assets/club-buttons/wallets/desktop/wallet-player-wallet-v1.webp':
    '35d9c4c0ff6ab3fd6f58e5517fae0b7af153680426da3d92b0667dd70fbb48fb',
  'assets/club-buttons/wallets/desktop/wallet-promo-wallet-v1.webp':
    '5a30f749f5a406d71813e5e4f1685a12f531aed48f7bf8904540060fea11ea4e',
  'assets/club-buttons/wallets/desktop/wallet-rake-treasury-v1.webp':
    'f974e69bb703e0eb8e264bcd932d7fd4c4b9846dd7ecaea57f68c993a88dcd88',
  'assets/club-buttons/wallets/desktop/wallet-spins-treasury-v1.webp':
    'e1d12724125c54d9f555a1cf9b44e5a7a76f6929461181b4b3f4d0deaac0a5d8',
  'assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp':
    'f0b45ef58ffde4c1dbcce8f0cecd152430c7ea684137f58dccf6b16c08424687',
  'assets/club-buttons/wallets/mobile/wallet-agent-wallet-v1.webp':
    'd7393cd2b1e4c2e22e51425d98d954109fddb2672a445ee3ee3c7a2749052ef9',
  'assets/club-buttons/wallets/mobile/wallet-backup-bbj-wallet-v1.webp':
    '0cb3f193a0bf20bb7f83ead5e434650d2f4454347d3e393863b79f3f9e830d34',
  'assets/club-buttons/wallets/mobile/wallet-club-bank-v1.webp':
    '51c79592db5daa4f5894c61dead5bbb7834e7cd5e428e543bce31805c027b170',
  'assets/club-buttons/wallets/mobile/wallet-diamonds-v1.webp':
    '8bc87ae12e768dcd03952136aa347ba77afbf5f1edb920bfe36e448c5571059b',
  'assets/club-buttons/wallets/mobile/wallet-player-wallet-v1.webp':
    '8347f541c69d84c335fe6960324351fd387bac5cb3ff3409b91c06025984c55b',
  'assets/club-buttons/wallets/mobile/wallet-promo-wallet-v1.webp':
    'b0908db71733a39ef186c418840dd46f507c3204434ae8bd2de7b463ce581141',
  'assets/club-buttons/wallets/mobile/wallet-rake-treasury-v1.webp':
    '8a4e225ca1a1e28a21edb991ccbd31a64091745cfd82c983a5fcab9570231921',
  'assets/club-buttons/wallets/mobile/wallet-spins-treasury-v1.webp':
    '492ae7ba35b91d4d02d1764cb9310d4a01dbe3ca744d67cdad2b95dde0762ce8',
  'assets/club-buttons/wallets/mobile/wallet-union-bank-v1.webp':
    '3d29b49df88935c30f95dad89c1aa7c2787118cff65659af109644e06fcce401',
  'assets/club-buttons/wallets/my-wallets-v1/chassis.png':
    'f81a215cab07398fb4f5ddc6f5ed62ba03447570d9e30a50f6739119af462bfe',
  'assets/club-buttons/wallets/my-wallets-v1/source/approved-reference.png':
    'f0184c22610d1a63fae36cca9ff5d1cdd46292a63e219ba3ac0dd321ee56ae07',
  'assets/club-buttons/wallets/square/wallet-agent-wallet-square-v1.png':
    '694c7ca914c1decf446c21fd78e1a8515ff21533a28a062658313e380487b6d7',
  'assets/club-buttons/wallets/square/wallet-agent-wallet-square-v1.webp':
    '6710943e96f53f7c2938adb8f4c4b8ee7c60f877e44b74734aaeab9bfb2f90a2',
  'assets/club-buttons/wallets/square/wallet-backup-bbj-wallet-square-v1.png':
    '39ecd37339e1c4cf1df53055653d7cd351f7b5d68e7ff7bf35966cc2c9aacb9a',
  'assets/club-buttons/wallets/square/wallet-backup-bbj-wallet-square-v1.webp':
    'd8cf11d31ce8043f7674fa562d6f6d6e925e98d054bfb32e7d4758fdbb4c3dbe',
  'assets/club-buttons/wallets/square/wallet-club-bank-square-v1.png':
    '1ee92610e8fda7adda8299207b73afcf106d8efe5e558343971d9371f9d8e8da',
  'assets/club-buttons/wallets/square/wallet-club-bank-square-v1.webp':
    'a873992bbacb3ee03306a936777c1519e962f63236395bdd95ea36b5882e85c8',
  'assets/club-buttons/wallets/square/wallet-diamonds-square-v1.png':
    '0368d0f7f7e8791f09df43904c4fa63c263a151796a6ecaf88a3d9558b221fa6',
  'assets/club-buttons/wallets/square/wallet-diamonds-square-v1.webp':
    '484984e33a1e787fa71b8c059c8011fbfaaa61e3ebb6f6af2d8dec26df98bf42',
  'assets/club-buttons/wallets/square/wallet-player-wallet-square-v1.png':
    'dc399b9ced63311e7803410a41f4054e8ce909cf368be247cdf818b7f59440e4',
  'assets/club-buttons/wallets/square/wallet-player-wallet-square-v1.webp':
    'edc3939fdbfe4604b1841cb998cb6f6ec93b12b876ef6cc7d5ace92d0d563f91',
  'assets/club-buttons/wallets/square/wallet-promo-wallet-square-v1.png':
    '5438640fa5d42bf8e38698b7247e530966fdefe9310002e2213e350643f1c823',
  'assets/club-buttons/wallets/square/wallet-promo-wallet-square-v1.webp':
    'eac7d4ddf1ba5835bb71faddef5e53d605e895bceb47f21e1feb1ea4c052c11f',
  'assets/club-buttons/wallets/square/wallet-rake-treasury-square-v1.png':
    'bd611410b5bb570b64edb6cedb8ed05546ddaf040fae32e8894e9f09c58026fd',
  'assets/club-buttons/wallets/square/wallet-rake-treasury-square-v1.webp':
    '85c3b24c50b42dd179ecf82987aead25f47598042e57410d9ee0e536c223863d',
  'assets/club-buttons/wallets/square/wallet-spins-treasury-square-v1.png':
    'e0b3b5714181de94241e6dd6ab5f0bb428aecdc11be52bf88e37e6e3f8c03dd6',
  'assets/club-buttons/wallets/square/wallet-spins-treasury-square-v1.webp':
    '9950a20e4471121fdbc1ab12d64f8daa525485d30f5d77dc5dd2ba992b4ec7d5',
  'assets/club-buttons/wallets/square/wallet-union-bank-square-v1.png':
    '7a9dfb941269b43f8899f8120abdb11951ea7952893121810f5b560fe286380a',
  'assets/club-buttons/wallets/square/wallet-union-bank-square-v1.webp':
    '22df40222ea8eb2474390ec738a419e8828954c902298be545fb30f5ad2b47c0',
  'assets/club-buttons/wallets/wallet-mark-v1.svg':
    'e4034d1a3e0899a6b021f6014680efbcf1aa3fe12eb1e94dcf1575dc0fe019da',
};

/**
 * A 2400x2400 PNG of deterministic noise. Noise on purpose: a smooth gradient
 * palette-quantizes down past MIN_BYTES and then stops being a candidate at
 * all, which would make the second and third passes trivially "unchanged" for
 * the wrong reason. This fixture stays a candidate on every pass, so the only
 * thing that can make a later pass a no-op is the cache doing its job.
 */
async function makeBigPng(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const side = 2400;
  const raw = Buffer.alloc(side * side * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >> 16) & 0xff;
  }
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function run(root: string, cache: string): string {
  return execFileSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    env: { ...process.env, CA_DIST_MEDIA_CACHE: cache },
  });
}

describe('the media optimizer remembers, and running it twice changes nothing', () => {
  let root: string;
  let cache: string;
  let target: string;
  let originalSize: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ca-dist-media-law-'));
    cache = join(root, 'cache');
    mkdirSync(join(root, 'dist', 'images'), { recursive: true });
    target = join(root, 'dist', 'images', 'law-fixture.png');
    const png = await makeBigPng();
    writeFileSync(target, png);
    originalSize = statSync(target).size;
    expect(originalSize).toBeGreaterThan(40 * 1024);
  }, 60_000);

  it('optimizes on a cold cache, and reports the miss', () => {
    const out = run(root, cache);
    expect(out).toMatch(/optimized=1\b/);
    expect(out).toMatch(/cache=0hit\/1miss/);
    expect(statSync(target).size).toBeLessThan(originalSize);
  }, 60_000);

  it('running it again re-encodes NOTHING - the output recognises itself', () => {
    const before = readFileSync(target);
    const out = run(root, cache);
    expect(out).toMatch(/optimized=0\b/);
    expect(out).toMatch(/cache=1hit\/0miss/);
    // Byte-identical: no generational re-encode of an already-optimized file.
    expect(readFileSync(target).equals(before)).toBe(true);
  }, 60_000);

  it('a fresh dist with the same bytes is served from cache, not re-encoded', () => {
    // Reset the file to its original bytes, as a fresh `vite build` would.
    const second = join(root, 'dist', 'images', 'law-fixture-copy.png');
    writeFileSync(second, readFileSync(join(root, 'dist', 'images', 'law-fixture.png')));
    const out = run(root, cache);
    expect(out).toMatch(/cache=2hit\/0miss/);
    expect(out).toMatch(/optimized=0\b/);
    rmSync(second);
  }, 60_000);

  it('runs a worker pool, so the box is used rather than one core of it', () => {
    const out = run(root, cache);
    const pool = /pool=(\d+)/.exec(out);
    expect(pool, 'the optimizer no longer reports its pool width').toBeTruthy();
    expect(Number(pool![1])).toBeGreaterThan(0);
    const src = readFileSync(SCRIPT, 'utf8');
    // One libvips thread per image; the pool is where the parallelism lives.
    // Reversing this (sharp's default concurrency x a wide pool) oversubscribes
    // the box and was measurably slower than either extreme.
    expect(src).toContain('sharp.concurrency(1)');
  }, 60_000);

  it('every input to the encode is part of the cache key', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Bump ENCODER_SETTINGS_VERSION when the png/webp/jpeg options change.
    // It is the only thing standing between an encoder change and a cache
    // that keeps serving the previous encoder's bytes.
    expect(src).toContain('ENCODER_SETTINGS_VERSION');
    expect(src).toMatch(/rule\.maxDim.*ext.*ENCODER_SETTINGS_VERSION.*sharp\$\{sharpVersion\}/s);
    // sharp's own version too: a new libvips can produce different bytes.
    expect(src).toContain('sharpVersion');
  });
});

// These are the two actual rejected/published JPEG variants: same former Vite
// URL and length, different final compressed bytes. No codec determinism is
// assumed; both cache/platform outcomes must be safe to publish immutably.
it('names final encoded bytes before Vite binds JS and CSS URLs, then leaves them immutable', async () => {
  const { build } = await import('vite');
  const sharp = (await import('sharp')).default;
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const original = readFileSync(join(ROOT, 'src/assets/backgrounds/bg_skin_gilded_fall.jpg'));
  const variants = ['public', 'candidate'].map((kind) =>
    readFileSync(join(ROOT, `tests/fixtures/media/gilded-fall-${kind}.jpg`))
  );
  expect(variants.map(sha)).toEqual([
    'e16dd9e9651f8d3ac8af25fa0b33420f5b8c9cd93e8461df3d4d452d3288c409',
    'f4fb518133b9effea630df777594394e0a4a10a8117fea5fc6dc142706af28cb',
  ]);
  expect(variants[0].length).toBe(variants[1].length);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ca-vite-media-law-')));
  const previousCache = process.env.CA_DIST_MEDIA_CACHE;
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'cache'));
    writeFileSync(join(root, 'src/image.jpg'), original);
    writeFileSync(join(root, 'src/style.css'), '.photo { background-image: url("./image.jpg"); }');
    writeFileSync(
      join(root, 'main.js'),
      'import url from "./src/image.jpg"; import "./src/style.css"; globalThis.imageUrl = url;'
    );
    writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    process.env.CA_DIST_MEDIA_CACHE = join(root, 'cache');
    const key = sha(Buffer.from(`${sha(original)}|1280|jpg|v1|sharp${sharp.versions.sharp}`));
    const names: Array<{ image: string; js: string; css: string }> = [];
    for (const bytes of variants) {
      // A legitimate retained encoder result for the same original input.
      writeFileSync(join(root, 'cache', `${key}.bin`), bytes);
      const media = viteMediaIdentity();
      const result = await build({
        configFile: false,
        root,
        base: '/hub/club-arena/',
        logLevel: 'silent',
        plugins: [media.plugin],
        build: {
          minify: false,
          assetsInlineLimit: 0,
          rollupOptions: { output: { assetFileNames: media.assetFileNames } },
        },
      });
      if (!('output' in result)) throw new Error('fixture must emit one Rollup output');
      const image = result.output.find((item) => item.fileName.endsWith('.jpg'))!;
      const js = result.output.find((item) => item.type === 'chunk')!;
      const css = result.output.find((item) => item.fileName.endsWith('.css'))!;
      expect(image.fileName).toContain(sha(bytes));
      expect(readFileSync(join(root, 'dist', image.fileName))).toEqual(bytes);
      expect(readFileSync(join(root, 'dist', js.fileName), 'utf8')).toContain(image.fileName);
      expect(readFileSync(join(root, 'dist', css.fileName), 'utf8')).toContain(image.fileName);
      run(root, join(root, 'cache'));
      expect(readFileSync(join(root, 'dist', image.fileName))).toEqual(bytes);
      names.push({ image: image.fileName, js: js.fileName, css: css.fileName });
    }
    expect(names[0].image).not.toBe(names[1].image);
    expect(names[0].js).not.toBe(names[1].js);
    expect(names[0].css).not.toBe(names[1].css);
    expect(readFileSync(join(root, 'src/image.jpg'))).toEqual(original);
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain('mediaIdentity.plugin');
    expect(config).toContain('assetFileNames: mediaIdentity.assetFileNames');
  } finally {
    if (previousCache === undefined) delete process.env.CA_DIST_MEDIA_CACHE;
    else process.env.CA_DIST_MEDIA_CACHE = previousCache;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it('retains the sealed bytes behind every existing permanent public asset URL', () => {
  for (const [asset, expected] of Object.entries(SEALED_PUBLIC_ASSET_BYTES)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(ROOT, 'public', asset)))
      .digest('hex');
    expect(actual, asset).toBe(expected);
  }
});

it('keeps pooled public bytes unchanged on both cold and divergent warm caches', async () => {
  const sharp = (await import('sharp')).default;
  const root = mkdtempSync(join(tmpdir(), 'ca-public-media-law-'));
  const cache = join(root, 'cache');
  const asset = 'assets/permanent-public-fixture.png';
  const finalBytes = await makeBigPng();
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', asset), finalBytes);
    run(root, cache);
    expect(sha(readFileSync(join(root, 'dist', asset)))).toBe(sha(finalBytes));
    // Even a disposable cache populated by another encoder cannot own the
    // bytes at a permanent public URL. Imported Vite assets retain their
    // separate, final-content-addressed optimization contract above.
    const key = sha(Buffer.from(`${sha(finalBytes)}|1280|png|v1|sharp${sharp.versions.sharp}`));
    writeFileSync(
      join(cache, `${key}.bin`),
      readFileSync(
        join(ROOT, 'public/assets/club-buttons/game-cards/plo/spade-plo-premium-v1/chassis.png')
      )
    );
    run(root, cache);
    expect(sha(readFileSync(join(root, 'dist', asset)))).toBe(sha(finalBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
