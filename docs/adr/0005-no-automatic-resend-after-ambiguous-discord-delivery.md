# Do not resend ambiguous Discord output automatically

Discord may accept a response chunk just before inoai stops, leaving SQLite without the returned Discord message ID. Retrying that chunk could duplicate output. Phase 5 persists the chunk first, records ambiguous delivery as uncertain, and never resends it automatically on restart. This favors no duplicate output over guaranteed Discord delivery; the complete response stays in the local archive for inspection.
