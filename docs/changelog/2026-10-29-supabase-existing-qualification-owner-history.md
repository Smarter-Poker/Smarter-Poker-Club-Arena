# Supabase qualification uses its existing required owners

Repeated concurrent changes to the whole CI workflow and its active fingerprints caused merge conflicts after qualification. The existing required Accounting2 Data Console owner now invokes the full hosting wrapper, which itself executes Member Record once. Accounting3 retains its existing native owner and upload. No native assertions, required checks or source-binding validation are weakened. The workflow and its six active workflow fingerprints match protected main exactly.

The prior task-only audit objects and then-active fingerprints below are historical source records from 30e7b9b4395372b17b315cae105f0aa002415999, not current pins or renewed qualification.

```json
{
  "scripts/qualification/cash-native-hosted.manifest.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      },
      "scripts/ci/classify-ci-changes.mjs": {
        "bytes": 44073,
        "sha256": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 native gateway/bootstrap qualification and exact source classifier routing. Existing accounting commands, assertions, financial sources, historical receipts and qualification states unchanged. Current input identity only; hosted execution remains required.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          },
          "scripts/ci/classify-ci-changes.mjs": {
            "previous": {
              "bytes": 42104,
              "sha256": "8b6f39c692d4203313bff6c57d6a2719d6ef59b1ca0be9619be4d2aceaa14edf"
            },
            "current": {
              "bytes": 42862,
              "sha256": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a"
            }
          }
        }
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        }
      },
      "gatewayNativeAlertComposition20261028": {
        "reason": "Preserve both protected-main native-alert qualification selectors and independent gateway hosting selectors. JSON three-way composition retains both parents audit records. Current classifier/nested binding identity only; financial source, assertions and historical qualification unchanged.",
        "previous": {
          "bytes": 42862,
          "sha256": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a"
        },
        "current": {
          "bytes": 43436,
          "sha256": "c35b9acbd6451e346cb09a5e19abf0f372f1b8e4b12939eb3d8e0602e06f6ef0"
        }
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "previous": {
          "bytes": 243571,
          "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
        },
        "current": {
          "bytes": 243853,
          "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
        }
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "inheritedMainHistoricalAuditSnapshots": {
        "reason": "Main had rewritten historical classifier fingerprints before this composition. Preserve its exact inherited objects here while leaving the original candidate historical objects unchanged; neither is new financial certification.",
        "revision": "859ed4eac45449f53af4f9ced021a65b64263d71",
        "objects": {
          "handSubmissionIntegration": {
            "reason": "Existing Accounting job directly invokes retained-hand native qualification; selector and routing regression expanded. Cash SQL and immutable capture inputs unchanged.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 149836,
                "sha256": "e3a1de6444d5ad4901c9213b53987c36d2c639e3a919d759fb155c250b35ed63"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 88814,
                "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
              }
            },
            "mainIntegration": {
              "revision": "59759374f63503f046b00fc54d3e0c161b87a0f4",
              "previousPins": {
                ".github/workflows/ci.yml": {
                  "bytes": 149836,
                  "sha256": "e3a1de6444d5ad4901c9213b53987c36d2c639e3a919d759fb155c250b35ed63"
                },
                "scripts/ci/classify-ci-changes.mjs": {
                  "bytes": 42836,
                  "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
                },
                "tests/unit/fixtureNativeCi.test.ts": {
                  "bytes": 88814,
                  "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
                }
              },
              "reason": "Preserves accepted elimination, Spin fee, PKO and cash-week routes while adding the same retained-submission route; exact merged workflow and selector bytes."
            },
            "noStartParent": "1d1a6cced3cd956e99dd94e3a63de159fcda1010",
            "movementParent": {
              "revision": "f3e5bae43395980fc49ca02876b3f94818a54672",
              "previousPins": {
                ".github/workflows/ci.yml": {
                  "bytes": 149836,
                  "sha256": "e3a1de6444d5ad4901c9213b53987c36d2c639e3a919d759fb155c250b35ed63"
                },
                "scripts/ci/classify-ci-changes.mjs": {
                  "bytes": 42836,
                  "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
                },
                "tests/unit/fixtureNativeCi.test.ts": {
                  "bytes": 88814,
                  "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
                }
              },
              "reason": "Compose both existing Accounting native routes and all routing assertions. Cash SQL and capture inputs unchanged."
            },
            "stockToolchainBinding": {
              "previousPins": {
                ".github/workflows/ci.yml": {
                  "bytes": 149836,
                  "sha256": "e3a1de6444d5ad4901c9213b53987c36d2c639e3a919d759fb155c250b35ed63"
                },
                "scripts/ci/classify-ci-changes.mjs": {
                  "bytes": 42836,
                  "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
                },
                "tests/unit/fixtureNativeCi.test.ts": {
                  "bytes": 88814,
                  "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
                }
              },
              "reason": "Pass the already-built PG_ISOLATION_TESTER artifact explicitly to the journal native runner; routing assertion reproduced missing environment before repair."
            },
            "finalMovementParent": {
              "revision": "546421d4a8080b6cf8127c538e9043f3219beb6a",
              "movementParentPins": {
                ".github/workflows/ci.yml": {
                  "bytes": 149836,
                  "sha256": "e3a1de6444d5ad4901c9213b53987c36d2c639e3a919d759fb155c250b35ed63"
                },
                "scripts/ci/classify-ci-changes.mjs": {
                  "bytes": 42836,
                  "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
                },
                "tests/unit/fixtureNativeCi.test.ts": {
                  "bytes": 88814,
                  "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
                }
              },
              "reason": "Preserves final movement native metadata and result-validator correction, both qualification routes and exact merged source bytes; Cash SQL untouched."
            }
          },
          "mixedCustodyIntegration": {
            "reason": "Mixed custody qualification is routed through the existing accounting lane; both existing and retained-MTT selectors are preserved. Cash SQL and immutable fixture inputs are unchanged.",
            "previousPins": {
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 88814,
                "sha256": "072cab77afdde70045ab72130997af4f74108a25a8f4a9a77391f1db80547b57"
              }
            }
          },
          "cashierStatementsIntegration": {
            "reason": "Phase 5 cashier statements: ci.yml gains the cashier-statements fixture step; classify-ci-changes and fixtureNativeCi register the cashier-statements runner (additive only). Cash SQL and immutable capture inputs unchanged.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 155443,
                "sha256": "c0d3b2129194aabf06b055fab3303ff927f10c156656dffb9447afd3ab3b498b"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 90321,
                "sha256": "05915fc1366204c2f2f59c46bda2a4ee609c5675d8a142e0f9941d21eb58a6c9"
              }
            }
          },
          "horseAdmissionInputRouting": {
            "reason": "Horse prevention regression uses the existing accounting job; adds its module, race, paid-entry fixture and provider directories plus modification/deletion/rename controls. Cash SQL and all historical manifest pins unchanged.",
            "previousPins": {
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 92029,
                "sha256": "739821b7d618d4497a49912a5246f3b2764aa9ce1a80180ffa16a5bf41ec624f"
              }
            },
            "integration_note": "Preserve current main discovery routing and horse routing together; bind actual integrated classifier."
          },
          "cashierTotalsIndexIntegration": {
            "reason": "Cashier totals online index companion selects the existing native accounting lane and client routing tests; financial SQL and captured accounting inputs remain unchanged. Cascaded pins reflect only this reviewed additive routing and current binding metadata.",
            "previousPins": {
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            }
          },
          "scoped_audit_reads_rebinding_20260927": {
            "reason": "Add the native scoped achievement and rate-history SELECT policy qualification to accounting shard 4 and classify its isolated inputs. No existing financial fixtures or assertions changed.",
            "previous": {
              ".github/workflows/ci.yml": {
                "bytes": 168945,
                "sha256": "a4a2eb4a09c00b2b025d12b0689cfb8ef5c7a5330cce1514897adbc276833b02"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            },
            "current": {
              ".github/workflows/ci.yml": {
                "bytes": 169118,
                "sha256": "ebe2e5f49b298b24325f14f7d35f07fb393eef0759188fb919f1efee76e559c8"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            }
          },
          "bbjAuditReadQualification20260927": {
            "reason": "Add BBJ audit-read native runner, immutable input and connected source-test routing to existing required accounting and client jobs; retain all prior routing, financial assertions and historical audit records.",
            "previous": {
              ".github/workflows/ci.yml": {
                "bytes": 169529,
                "sha256": "41fbedcb119643e56ce9d32d9f56e41efae4a94ee603cb66ee4943e251d3ab3c"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            },
            "updated": {
              ".github/workflows/ci.yml": {
                "bytes": 169704,
                "sha256": "0b775e67c48ce61d46b869f0d23b7802d60a785fbfe8c6ac2d2e83fac373bbba"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            }
          },
          "bbjContributionCoverIntegration20260927": {
            "reason": "Add native PG17 qualification of the BBJ contribution covering index and its unchanged installed RPCs to accounting shard 4, including concurrent writes, real interrupted index refusal, source/type drift and role isolation. Existing accounting fixtures and assertions stay unchanged.",
            "previous": {
              ".github/workflows/ci.yml": {
                "bytes": 169529,
                "sha256": "41fbedcb119643e56ce9d32d9f56e41efae4a94ee603cb66ee4943e251d3ab3c"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            },
            "current": {
              ".github/workflows/ci.yml": {
                "bytes": 169779,
                "sha256": "f9797380e7c19134282f7f60603f0e754c54aa07d2fba31818a1f8d3bdfc617e"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            }
          },
          "stableAdminNativeEnforcement20261010": {
            "reason": "Stable Admin six-capability integration: add two original-owner PG17 qualifiers to the existing required accounting shards, classify their drivers/loaded fixtures/schema fragments, and test that enforcement. Reviewed additive workflow/classifier/test diff; no prior financial authority, assertion, captured fixture or qualification status changes. Source fingerprint refresh does not prove native execution, installation or publication.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 197294,
                "sha256": "a9422a1122cfd4a39c721d93ba0ff2e9dc3a2615fde2da36aec451be35733914"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 102135,
                "sha256": "0ed8b0f3eedcd503d45f07a52cb720a436cd6f9f410db9eb656d984b23d3fb9f"
              }
            }
          },
          "nativeRecoveryExport20261012": {
            "reason": "Add the native read-only export/restore fixture to existing accounting shards1/4 and classify every maintained tool input. Refresh only these reviewed workflow/classifier fingerprints; retained financial source pins, assertions and SOURCE_ONLY_UNRUN status remain unchanged. This is not financial or full production recovery qualification.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 202788,
                "sha256": "cbecb15da2fd2b57f1c3fcb7a75f9eede415cef9ad40bce2f25257266ca3f732"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 105657,
                "sha256": "1e9a652b80aa851fb95d7780aeb6b62d360a7b61192c27edd9112ecd0b636392"
              }
            },
            "currentMainPreviousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 203003,
                "sha256": "1699ddcbdafde77bbb538e632911eb11663486d78a99571e67006ae4f4004995"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 105657,
                "sha256": "1e9a652b80aa851fb95d7780aeb6b62d360a7b61192c27edd9112ecd0b636392"
              }
            }
          },
          "scopedLaunchResetQualification20261012": {
            "reason": "Enforce the real scoped reset/undo and candidate-bound reporting, invoice permissions and floor regression in existing Accounting1. Refresh only these reviewed workflow/classifier/fixture wiring source fingerprints; all financial originals, assertions, historical pins and SOURCE_ONLY_UNRUN status remain unchanged. This is not production reset certification.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 204868,
                "sha256": "526ce2cb5ae8c17319b7181238858a9d820a4609f4a90f7572c19d316d552ee9"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              },
              "tests/unit/fixtureNativeCi.test.ts": {
                "bytes": 105731,
                "sha256": "14a67e65f162b0c02c406ae9b24726852f5d5678c28f01ba861633b9c6ea9682"
              }
            }
          },
          "satelliteCurrentMainIntegration20261013": {
            "reason": "Preserve all current main CI routing and exact installed union source, add satellite-only native cohort and registry qualification. Source identity only, no financial authority or qualification status changed.",
            "previousPins": {
              ".github/workflows/ci.yml": {
                "bytes": 219700,
                "sha256": "8716d2d184b824c542069f47d4f542bbbdb71f3246ed2b4b3f9ba07885b62002"
              },
              "scripts/ci/classify-ci-changes.mjs": {
                "bytes": 42836,
                "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
              }
            }
          }
        }
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          },
          {
            "section": "files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": {
              "bytes": 43594,
              "sha256": "f45171a86206de8b4412c1ac44ecb25c5e26cdfe419b58de79a89ce35360c079"
            },
            "current": {
              "bytes": 44018,
              "sha256": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressCurrentInputIdentity20261028": {
        "reason": "Reviewed additive Accounting shard3 retention-progress fixture/artifact and its input-only classifier selectors. Restamp only those two current enforcement inputs; preserve all historical audit objects, financial sources/assertions, native qualification status and production acceptance. No new financial or production qualification is claimed.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          },
          "scripts/ci/classify-ci-changes.mjs": {
            "previous": {
              "bytes": 42836,
              "sha256": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5"
            },
            "current": {
              "bytes": 42891,
              "sha256": "7cdf8eef50913a0fa8dcd6d1d80d76d803a989b852ce6edb9574a768b94523e6"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          },
          "scripts/ci/classify-ci-changes.mjs": {
            "protectedMain": {
              "bytes": 43260,
              "sha256": "323340619338b17f9289eabb658c049dc6450a6f055f4b2327a3d12329c68a02"
            },
            "combined": {
              "bytes": 43315,
              "sha256": "dd765f387a791128e7572a4620820707d09e9f12294684456886fe9dc6c97c4e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          },
          {
            "section": "files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": {
              "bytes": 44018,
              "sha256": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7"
            },
            "current": {
              "bytes": 44073,
              "sha256": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
            }
          }
        ]
      }
    }
  },
  "scripts/qualification/cash-original17/source-binding.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          }
        ]
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        ]
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            },
            "current": {
              "bytes": 243853,
              "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
            }
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          }
        ]
      }
    }
  },
  "scripts/qualification/original-flow-eligibility/source-binding.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          }
        ]
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        ]
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            },
            "current": {
              "bytes": 243853,
              "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
            }
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          }
        ]
      }
    }
  },
  "scripts/qualification/weekly-cohort-cutoff/source-binding.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          }
        ]
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        ]
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            },
            "current": {
              "bytes": 243853,
              "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
            }
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          }
        ]
      }
    }
  },
  "scripts/qualification/weekly-initial-selector/source-binding.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          }
        ]
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        ]
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            },
            "current": {
              "bytes": 243853,
              "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
            }
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          }
        ]
      }
    }
  },
  "scripts/qualification/weekly-standalone-selector/source-binding.json": {
    "active_enforcement_pins": {
      ".github/workflows/ci.yml": {
        "bytes": 250924,
        "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
      }
    },
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243205,
              "sha256": "52177b46b2a13e29bf978ad7d83ebf7a9cfe1ece42861308436c5824ded90470"
            },
            "current": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            }
          }
        ]
      },
      "typecheckCompletionBudget20261028": {
        "reason": "Required typecheck job122952418582 passed all recorded checks but exceeded 15m at terminal cleanup (15m03; previous successful equivalent13m45). Increase only existing job outer timeout to20m for measured completion headroom. Commands, checks, assertions, matrix, qualification state and historical evidence unchanged; current input identity only.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243420,
              "sha256": "58dd37d0f2be1dbc53ee2a5f9330a2fa877e4c85429459c12dae358b67dd5fbf"
            },
            "current": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            }
          }
        ]
      },
      "gatewayIncidentReaderComposition20261028": {
        "reason": "Compose both measured 20-minute typecheck timeout explanations and preserve new protected-main bounded incident-reader qualification alongside gateway hosting. Current workflow binding only; historical audits, all financial source/assertions and qualification state unchanged.",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 243571,
              "sha256": "d7535f96375f5f37540c7e2ad2be991687366f7fbb97207843e3e9cfc6c27a85"
            },
            "current": {
              "bytes": 243853,
              "sha256": "a061c8062be0468dcfedcb4093d9f5bbdff1fc7c2ad80eec3fa64ded64553d0e"
            }
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 244819,
              "sha256": "697ee204e770c5509d3000f22d42ce1e9d70070ae4119d6ca730e51289690a01"
            },
            "current": {
              "bytes": 249868,
              "sha256": "8407df4b26ce41ea54a1fded55af465fa02f7321de9215483ce94e19e41a6457"
            }
          }
        ]
      },
      "gatewayProtectedMainComposition20261029b": {
        "reason": "Compose protected main period-fee qualification with gateway workflow. Preserve both parent audit objects and financial SQL, fixtures and assertions. Current workflow source identity only; no execution or financial recertification.",
        "main": "ddb62f02f5475538dd07fb6571375d444d1bdd04",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250045,
          "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
        }
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          ".github/workflows/ci.yml": {
            "previous": {
              "bytes": 244453,
              "sha256": "23a37ba22d2aaaac105a86bdc74f3bccc9daa2f00a36047348162ded048eb911"
            },
            "current": {
              "bytes": 245332,
              "sha256": "dd2624fb40c4b7a19dffdc819e0789e3957d3935bd8e833995a9f559124ab52e"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          ".github/workflows/ci.yml": {
            "protectedMain": {
              "bytes": 249502,
              "sha256": "8d023bb9aa44d83a66c329fb4ef679dd7e45b7e58c802b37db3e9ed9529a605c"
            },
            "combined": {
              "bytes": 250381,
              "sha256": "6be50c74b5819cec2a48e8119d403c6928c035f2953cb3a3e7f848821b0e0b3a"
            }
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressPeriodFeeMainIntegration20261029": {
        "reason": "Combine existing required retention Accounting3 qualification and protected-main period-fee Accounting4 step. Both parents historical audit records preserved; current workflow source identity only. No financial source, assertions or runtime changes and no financial recertification.",
        "path": ".github/workflows/ci.yml",
        "current": {
          "bytes": 250558,
          "sha256": "a48a0140340d3b033f094c2f1918949ded801baba2b22edd159a96c79f8c1870"
        }
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "files",
            "path": ".github/workflows/ci.yml",
            "previous": {
              "bytes": 250045,
              "sha256": "0b6d6594489d70cbb7f754c8e17004899af408107497a315d2701f9c73597369"
            },
            "current": {
              "bytes": 250924,
              "sha256": "94ab1096dd6278f148642316261344a33e95cd635899aaf07d01ef68e069378d"
            }
          }
        ]
      }
    }
  }
}
```

## Historical classifier binding audits before shared-tail cleanup

All task-added or task-modified historical objects removed from the four shared binding files are preserved below. Shared files retain every protected-main key, value and order; only necessary active classifier and derived child identities differ. This source record does not claim financial or production recertification.

```json
{
  "tests/fixtures/legacy-fee-finality/source-binding.json": {
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "8b6f39c692d4203313bff6c57d6a2719d6ef59b1ca0be9619be4d2aceaa14edf",
            "current": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a"
          }
        ]
      },
      "gatewayNativeAlertComposition20261028": {
        "reason": "Preserve both protected-main native-alert qualification selectors and independent gateway hosting selectors. JSON three-way composition retains both parents audit records. Current classifier/nested binding identity only; financial source, assertions and historical qualification unchanged.",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a",
            "current": "c35b9acbd6451e346cb09a5e19abf0f372f1b8e4b12939eb3d8e0602e06f6ef0"
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "f45171a86206de8b4412c1ac44ecb25c5e26cdfe419b58de79a89ce35360c079",
            "current": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7"
          }
        ]
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "previous": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5",
            "current": "7cdf8eef50913a0fa8dcd6d1d80d76d803a989b852ce6edb9574a768b94523e6"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "protectedMain": "323340619338b17f9289eabb658c049dc6450a6f055f4b2327a3d12329c68a02",
            "combined": "dd765f387a791128e7572a4620820707d09e9f12294684456886fe9dc6c97c4e"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7",
            "current": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
          }
        ]
      }
    }
  },
  "tests/fixtures/sep8-spin-custody/source-binding.json": {
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "8b6f39c692d4203313bff6c57d6a2719d6ef59b1ca0be9619be4d2aceaa14edf",
            "current": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a"
          }
        ]
      },
      "gatewayNativeAlertComposition20261028": {
        "reason": "Preserve both protected-main native-alert qualification selectors and independent gateway hosting selectors. JSON three-way composition retains both parents audit records. Current classifier/nested binding identity only; financial source, assertions and historical qualification unchanged.",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a",
            "current": "c35b9acbd6451e346cb09a5e19abf0f372f1b8e4b12939eb3d8e0602e06f6ef0"
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "f45171a86206de8b4412c1ac44ecb25c5e26cdfe419b58de79a89ce35360c079",
            "current": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7"
          }
        ]
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "previous": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5",
            "current": "7cdf8eef50913a0fa8dcd6d1d80d76d803a989b852ce6edb9574a768b94523e6"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "protectedMain": "323340619338b17f9289eabb658c049dc6450a6f055f4b2327a3d12329c68a02",
            "combined": "dd765f387a791128e7572a4620820707d09e9f12294684456886fe9dc6c97c4e"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "repository_files",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7",
            "current": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
          }
        ]
      }
    }
  },
  "scripts/qualification/cash-native-hosted.manifest.json": {
    "historical_audit_objects": {
      "privateRecordRetentionClassifierIdentity20261029": {
        "reason": "Keep required Accounting2 hosting and Accounting3 retention input selection in the existing owners. Workflow is byte-identical to protected main; this records only current classifier source identity, not financial or production qualification. Prior task workflow audit objects are retained verbatim in docs/changelog/2026-10-29-supabase-existing-qualification-owner-history.md.",
        "path": "scripts/ci/classify-ci-changes.mjs",
        "previous": {
          "bytes": 43260,
          "sha256": "323340619338b17f9289eabb658c049dc6450a6f055f4b2327a3d12329c68a02"
        },
        "current": {
          "bytes": 44073,
          "sha256": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
        }
      }
    }
  },
  "tests/fixtures/full-weekly-accounting/source-binding.json": {
    "historical_audit_objects": {
      "privateRecordGatewayHosting20261028": {
        "reason": "Reviewed additive required shard2 gateway native hosting/bootstrap qualification and classification. Existing financial commands, sources, assertions, verdicts and historical receipts remain unchanged. Current input identity only; hosted execution remains required.",
        "changes": [
          {
            "section": "repository_fixtures",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "8b6f39c692d4203313bff6c57d6a2719d6ef59b1ca0be9619be4d2aceaa14edf",
            "current": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/legacy-fee-finality/source-binding.json",
            "previous": "b6ef5f7f9e1324d2ac3744c2a9ce2afe62bdf312b680423daf1e264b5d20106d",
            "current": "380521dab515909d9d373d0e2a7b88bfe67345975cb10abc93243eef53c7fe53"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/sep8-spin-custody/source-binding.json",
            "previous": "a60a0ef77be8fb2a1bcc49c7a9f2f0b0347c9550e550cf51982f328583587e02",
            "current": "30584b9dc31cc795ee38cafc73d73d56a7868c944923c5afac7dd79df3c902e5"
          }
        ]
      },
      "gatewayNativeAlertComposition20261028": {
        "reason": "Preserve both protected-main native-alert qualification selectors and independent gateway hosting selectors. JSON three-way composition retains both parents audit records. Current classifier/nested binding identity only; financial source, assertions and historical qualification unchanged.",
        "changes": [
          {
            "section": "repository_fixtures",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "1d8616209edfc077bc34cf9077d74c5914b9fee9815a4564a8c1dbdf3f04910a",
            "current": "c35b9acbd6451e346cb09a5e19abf0f372f1b8e4b12939eb3d8e0602e06f6ef0"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/legacy-fee-finality/source-binding.json",
            "previous": "380521dab515909d9d373d0e2a7b88bfe67345975cb10abc93243eef53c7fe53",
            "current": "f62ee7429527840a33019e5c28ae4eb8042115b9b632cb3cc990648add400735"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/sep8-spin-custody/source-binding.json",
            "previous": "30584b9dc31cc795ee38cafc73d73d56a7868c944923c5afac7dd79df3c902e5",
            "current": "381723c675962644e49a0b538369432e326a79f92df2d239d8ecc8ede2abbe42"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/legacy-fee-finality/source-binding.json",
            "previous": "f62ee7429527840a33019e5c28ae4eb8042115b9b632cb3cc990648add400735",
            "current": "513c96d82a5782003542ce8cb73628a88a6b1bcb1a975d065800fce0672342d8"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/sep8-spin-custody/source-binding.json",
            "previous": "381723c675962644e49a0b538369432e326a79f92df2d239d8ecc8ede2abbe42",
            "current": "966aac9fa80cf7709e486c764bb53b7e3983220aa3629f1db1439c743251397d"
          }
        ]
      },
      "gatewayRetentionMainComposition20261028": {
        "reason": "Preserve both parents gateway hosting and merged superseded horse action retention qualification and audit records. Active workflow/classifier bindings reflect composed source; historical financial assertions and certification remain unchanged.",
        "main": "859ed4eac45449f53af4f9ced021a65b64263d71"
      },
      "gatewayProtectedMainComposition20261029": {
        "reason": "Compose protected main repository-transfer and provider-runner fixes with gateway qualification. Preserve both parent audit objects and all financial SQL/fixtures/assertions. Exact current source identity only, not financial or production recertification.",
        "main": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "changes": [
          {
            "section": "repository_fixtures",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "f45171a86206de8b4412c1ac44ecb25c5e26cdfe419b58de79a89ce35360c079",
            "current": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/legacy-fee-finality/source-binding.json",
            "previous": "10b17a3fc5f8ea5999b85f88e8cbba546dd32ccc6e2124a660fd8bfe73ad7b1c",
            "current": "28eed1a8b808f2235fe94620b672371d7987d736edb62888b567c6162237c7d7"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/sep8-spin-custody/source-binding.json",
            "previous": "b3a9ab41321b5be27161f6c335dabe743b6d6ebee3ca054fdabac293128b9188",
            "current": "f8c56534f7d2da14070a063bb5ab25cdf5ea87f077431cee918c41eaefaf06ca"
          }
        ]
      },
      "supersededRetentionProgressEnforcement20261028": {
        "reason": "Reviewed exact retention progress CI diff: add the real PostgreSQL progress fixture and artifact retention to existing required Accounting shard3; classify its driver and source contract as required accounting inputs. Existing test commands, financial assertions, historical audit records and qualification states remain unchanged. Current source identity only; no financial or production certificate restamp.",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "previous": "9d6c91fd2524cc7dce4b83a156e3e104b8ae6ec9534a5fa690cc887bb592c2f5",
            "current": "7cdf8eef50913a0fa8dcd6d1d80d76d803a989b852ce6edb9574a768b94523e6"
          },
          "tests/fixtures/legacy-fee-finality/source-binding.json": {
            "previous": "e0d3e8174d258e01d25e101cae1ae48a400ee804b922bb92c2245dd717b2a4af",
            "current": "6c6b045496a6b12b882699cb07d1aa2645696bee2153f9f375062f5dae6e3fe6"
          },
          "tests/fixtures/sep8-spin-custody/source-binding.json": {
            "previous": "c95084251c5d64f8500cbfb00b24ab4700402bf7fcd1d084afa71926b4d849e0",
            "current": "ea7e210c5f7b8791575dda538d72811ac9ae643517fd88a24536a2d9e6fc5907"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "retentionProgressProtectedMainComposition20261029": {
        "reason": "Combine protected main915d5e2 with the retention progress qualification and additive Accounting3 selectors. Preserve every protected-main and branch historical audit object; update only current enforcement inputs and their derived child binding identities. Financial sources, assertions and qualification states remain unchanged.",
        "protectedMainRevision": "915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d",
        "branchRevision": "22b1078f8a19df37b7608a3111d5fab281da32c8",
        "changes": {
          "scripts/ci/classify-ci-changes.mjs": {
            "protectedMain": "323340619338b17f9289eabb658c049dc6450a6f055f4b2327a3d12329c68a02",
            "combined": "dd765f387a791128e7572a4620820707d09e9f12294684456886fe9dc6c97c4e"
          },
          "tests/fixtures/legacy-fee-finality/source-binding.json": {
            "protectedMain": "25a972fef5504416c6965bb07f73523a7e52fca179d9adce42de093e9e0a0167",
            "combined": "ba8ed8a5c88a952562ee481f04dacdc1f728b1153fc3d84f30e7c738dd75870e"
          },
          "tests/fixtures/sep8-spin-custody/source-binding.json": {
            "protectedMain": "7ee41e452d50a169c68780e8ce4a74cc82ff17ac9254291829b6df804eba20bb",
            "combined": "f2144127e1f8801eff7c91f6be6a702c4b16fb213a501df7a7337bfafa734829"
          }
        },
        "financial_qualification_performed": false,
        "production_actions": false
      },
      "gatewayRetentionUnion20261029": {
        "reason": "Consolidate the two authorized Supabase cost deliveries into one protected PR, preserving all A2 gateway, A3 retention and A4 period-fee checks and both audit histories. Only current combined enforcement identities and derived binding identities change; financial SQL, fixtures, assertions and historical qualification states remain unchanged. No financial recertification or production mutation.",
        "gatewayParent": "7072e0c8d3f22b8f67ff349a16c0569d0bb9372a",
        "retentionParent": "9bff34890fd20525a8f903b7c73dddefde95e454",
        "changes": [
          {
            "section": "repository_fixtures",
            "path": "scripts/ci/classify-ci-changes.mjs",
            "previous": "9e5ed80298e47f9821b956c479e6e7853da5c8ea42f867f4e235a460f253c4f7",
            "current": "39892c85bbd394dbecf82fab95fcdc5244d2405589b02d5bef1982cff92252de"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/legacy-fee-finality/source-binding.json",
            "previous": "28eed1a8b808f2235fe94620b672371d7987d736edb62888b567c6162237c7d7",
            "current": "32d467a2eebd2d822d002d804414127cf6fc9e227b20e215e59031ecafdde07e"
          },
          {
            "section": "repository_fixtures",
            "path": "tests/fixtures/sep8-spin-custody/source-binding.json",
            "previous": "f8c56534f7d2da14070a063bb5ab25cdf5ea87f077431cee918c41eaefaf06ca",
            "current": "b2779e470135070372b94e974427c858d86d3902f0ff10f0b049868860008638"
          }
        ]
      }
    }
  }
}
```
