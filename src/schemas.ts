// GENERATED from openapi.json — do not edit by hand.
//
// Per-route invocation contracts published inside the x402 402 challenge as
// `accepts[].outputSchema`. `input` tells an agent how to build the request
// (method, query/path params, JSON body fields); `output` is the JSON Schema of
// the 200 body it gets back once payment settles.
//
// Deriving these from `openapi.json` keeps the runtime challenge — which the
// x402scan discovery spec treats as authoritative — from ever contradicting the
// published spec. Regenerate whenever a paid route's parameters or response
// schema change.
//
// Keys match the paywall route map in `server.ts` exactly (`"<METHOD> <path>"`,
// with `:param` for path segments).

import type { RouteSchema } from "./payments.js";

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "POST /mailbox": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "bodyFields": {
        "label": {
          "type": "string",
          "description": "Your own bookkeeping label, echoed back"
        },
        "ttlSeconds": {
          "type": "number",
          "minimum": 60,
          "description": "Requested lifetime. Capped by the server's own TTL."
        }
      }
    },
    "output": {
      "type": "object",
      "required": [
        "mailbox"
      ],
      "properties": {
        "mailbox": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "relayAddress": {
                  "type": "string",
                  "format": "email",
                  "description": "PUBLIC. Give this to the sender."
                },
                "mailboxToken": {
                  "type": "string",
                  "description": "SECRET. This reads the mailbox."
                },
                "expiry": {
                  "type": "string",
                  "format": "date-time"
                },
                "createdAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "label": {
                  "type": "string"
                },
                "pollUrl": {
                  "type": "string"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "smtp": {
          "type": "object",
          "properties": {
            "host": {
              "type": "string"
            },
            "port": {
              "type": "number"
            }
          }
        },
        "paidWith": {
          "type": "object",
          "properties": {
            "success": {
              "type": "boolean"
            },
            "rail": {
              "type": "string",
              "enum": [
                "evm",
                "solana"
              ]
            },
            "network": {
              "type": "string"
            },
            "transaction": {
              "type": "string"
            },
            "payer": {
              "type": "string"
            },
            "amount": {
              "type": "string"
            },
            "asset": {
              "type": "string"
            },
            "resource": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "GET /codes/:token": {
    "input": {
      "type": "http",
      "method": "GET",
      "queryParams": {},
      "pathParams": {
        "token": {
          "type": "string",
          "x-required": true
        }
      }
    },
    "output": {
      "type": "object",
      "required": [
        "result"
      ],
      "properties": {
        "result": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "mailboxToken": {
                  "type": "string"
                },
                "relayAddress": {
                  "type": "string"
                },
                "expiry": {
                  "type": "string",
                  "format": "date-time"
                },
                "messageCount": {
                  "type": "integer"
                },
                "codes": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "string",
                        "description": "The code, or the URL when kind is link"
                      },
                      "kind": {
                        "type": "string",
                        "enum": [
                          "numeric",
                          "alphanumeric",
                          "link"
                        ]
                      },
                      "confidence": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      "method": {
                        "type": "string",
                        "enum": [
                          "labelled",
                          "subject",
                          "isolated-line",
                          "magic-link"
                        ]
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "subject",
                          "text",
                          "html"
                        ]
                      },
                      "context": {
                        "type": "string",
                        "description": "~80 chars of surrounding text"
                      }
                    }
                  }
                },
                "best": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "code": {
                          "type": "string",
                          "description": "The code, or the URL when kind is link"
                        },
                        "kind": {
                          "type": "string",
                          "enum": [
                            "numeric",
                            "alphanumeric",
                            "link"
                          ]
                        },
                        "confidence": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        },
                        "method": {
                          "type": "string",
                          "enum": [
                            "labelled",
                            "subject",
                            "isolated-line",
                            "magic-link"
                          ]
                        },
                        "source": {
                          "type": "string",
                          "enum": [
                            "subject",
                            "text",
                            "html"
                          ]
                        },
                        "context": {
                          "type": "string",
                          "description": "~80 chars of surrounding text"
                        }
                      }
                    },
                    {
                      "type": "null"
                    }
                  ],
                  "description": "Top-ranked non-link candidate"
                },
                "links": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "string",
                        "description": "The code, or the URL when kind is link"
                      },
                      "kind": {
                        "type": "string",
                        "enum": [
                          "numeric",
                          "alphanumeric",
                          "link"
                        ]
                      },
                      "confidence": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      "method": {
                        "type": "string",
                        "enum": [
                          "labelled",
                          "subject",
                          "isolated-line",
                          "magic-link"
                        ]
                      },
                      "source": {
                        "type": "string",
                        "enum": [
                          "subject",
                          "text",
                          "html"
                        ]
                      },
                      "context": {
                        "type": "string",
                        "description": "~80 chars of surrounding text"
                      }
                    }
                  }
                },
                "messages": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "receivedAt": {
                        "type": "string",
                        "format": "date-time"
                      },
                      "from": {
                        "type": "string"
                      },
                      "subject": {
                        "type": "string"
                      },
                      "codes": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "waitedMs": {
                  "type": "number",
                  "description": "Milliseconds since the mailbox was created"
                },
                "polledAt": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            }
          }
        },
        "paidWith": {
          "type": "object",
          "properties": {
            "success": {
              "type": "boolean"
            },
            "rail": {
              "type": "string",
              "enum": [
                "evm",
                "solana"
              ]
            },
            "network": {
              "type": "string"
            },
            "transaction": {
              "type": "string"
            },
            "payer": {
              "type": "string"
            },
            "amount": {
              "type": "string"
            },
            "asset": {
              "type": "string"
            },
            "resource": {
              "type": "string"
            }
          }
        }
      }
    }
  },
};
