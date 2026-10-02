# Link expiry, and clicks lost on restart

Two changes to the existing URL shortener.

## 1. Enhancement: link expiry

Campaign links should stop working when the campaign ends. When creating a link, the caller can give
either an absolute expiry time or a time-to-live in seconds. After that moment the short link must
no longer redirect, and the visitor should be told the link has expired rather than that it never
existed. Links created without an expiry keep working as they do today. The owner must still be
able to read the stats of an expired link.

## 2. Defect BUG-17: clicks go missing around deployments

Support compared the click totals of two campaigns with the ad platform's numbers. We under-count by
a handful of clicks every time the service is redeployed: clicks that arrive just before a restart
never show up in the stats.

## Constraint

Existing links, existing API clients and existing data must keep working.
