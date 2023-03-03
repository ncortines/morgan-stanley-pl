(() => {

    let theYear

    while (!theYear || Number.isNaN(theYear)) {
        theYear = Number.parseInt(prompt('Please enter the tax year'), 10)
    }

    const session = JSON.parse(sessionStorage.getItem('session_state'))

    const dollarsAmountRegex = /\$([0-9\.]+?)$/

    const extractDollarsAmount = text => text.match(dollarsAmountRegex)[1]

    const padNumber = number =>
        number < 10 ? '0' + number : number

    const moveOneDayBack = date => {
        date.setDate(date.getDate() - 1)
        return date
    }

    const download = text => {
        const link = document.createElement('a');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
        link.setAttribute('href', url);
        link.setAttribute('download', 'export.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    stringifyList = list =>
        ([Object.keys(list[0]).join(','), ...list.map(item => Object.values(item).join(','))]).join('\r\n')

    const stringifyData = data =>
        data.map(item => Array.isArray(item) ? stringifyList(item) : item).join('\r\n\r\n')

    const getDateString = date =>
        date.getFullYear() + '-' + padNumber((date.getMonth() + 1)) + '-' + padNumber(date.getDate())

    const getEmployeeId = () => {
        return session.participant.activeAccount.employeePK
    }

    const getAccessToken = () => {
        return session.api.accessToken
    }

    const fetchPreviousSixMonthsDividends = dateString =>
        fetch(`https://stockplan.morganstanley.com/graphql`, {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'authorization': getAccessToken(),
                'employeeId': getEmployeeId()
            },
            body: JSON.stringify({
                query: `
                    query ($currentDate: String, $consolidation: Boolean) {
                        events {
                            pastEvents(options: {date: $currentDate, consolidation: $consolidation}) {
                                date
                                description
                                type
                            }
                        }
                    }
                `,
                variables: {
                    consolidation: true,
                    currentDate: dateString
                }
            })
        })
        .then(response => response.json())
        .then(json => {
            return json.data.events.pastEvents.filter(event => {
                return event.type === 'CASH_DIVIDEND' && event.date.includes(String(theYear))
            })
            .map(event => ({
                date: event.date,
                amountUSD: Number(extractDollarsAmount(event.description))
            }))
        })

    const deduplicateDividendRecords = dividendRecords => {
        return Object.values(dividendRecords.reduce((dividendsMap, dividendRecord) => {
            dividendsMap[dividendRecord.date] = dividendRecord
            return dividendsMap
        }, {}))
    }

    const getDividendRecords = () => {
        return Promise.all([
            fetchPreviousSixMonthsDividends(`${theYear + 1}-01-01`),
            fetchPreviousSixMonthsDividends(`${theYear}-09-01`),
            fetchPreviousSixMonthsDividends(`${theYear}-05-01`)
        ])
        .then(dividendRecordLists => {
            const dividendRecords = deduplicateDividendRecords(dividendRecordLists.flat())
            return Promise.all(dividendRecords.map(dividendRecord => {
                const dividendDate = new Date(dividendRecord.date)
                return getExchangeRate(dividendDate)
                    .then(dividendExchangeRate => ({
                        date: dividendRecord.date,
                        exchangeRate: dividendExchangeRate,
                        amountUSD: dividendRecord.amountUSD,
                        amountPLN: dividendRecord.amountUSD * dividendExchangeRate
                    }))
            }))
        })
    }

    const fetchExchangeRate = date =>
        fetch(`https://api.nbp.pl/api/exchangerates/rates/a/usd/${getDateString(date)}/?format=json`)
            .then(response => {
                if (response.status === 200) {
                    return response.json()
                        .then(data => data.rates[0].mid)
                }
                if (response.status === 404) {
                    return undefined;
                }
                return Promise.reject(Error('problem fetching rate from nbp.pl'));
            })

    const getExchangeRate = (date, tries = 5) => {
        if (tries > 0) {
            return fetchExchangeRate(moveOneDayBack(date))
                .then(rate => rate || getExchangeRate(date, tries - 1))
        }
        return Promise.reject(Error('no rate found!'))
    }

    const fetchData = url =>
        fetch(url, {
            credentials: 'include',
            headers: {
                Authorization: session.api.sessionToken
            }
        })
        .then(response => response.json())

    const fetchSaleDetails = transactionId =>
        fetchData(session.api.baseUri + session.api.baseLegacyUriSuffix + '/withdrawals/' + transactionId)

    const fetchRtSaleDetails = transactionId =>
        fetchData(session.api.baseUri + session.api.baseLegacyUriSuffix + '/withdrawals/realtimeTransactions/' + transactionId)

    const fetchHistoryRecords = () =>
        fetchData(session.api.baseUri + session.api.baseLegacyUriSuffix + '/participants/' + getEmployeeId() + '/txHistory')
            .then(data => data.txs)

    const processSaleDetail = (detail, sellExchangeRate) =>
        getExchangeRate(new Date(detail.purchaseDate))
            .then(buyExchangeRate => {
                let buyValueUSD = 0;
                let buyValuePLN = 0;
                const quantity = Number(detail.quantity)
                const buyDate = new Date(detail.purchaseDate)
                const buyValuePerShare = Number(detail.bookValuePerShare.amount)
                if (buyDate.getFullYear() < 2018 || detail.coveredStatus === 'COVERED') {
                    buyValueUSD = buyValuePerShare * quantity;
                    buyValuePLN = buyValueUSD * buyExchangeRate;
                }
                const sellValuePerShare = Number(detail.marketValuePerShare.amount)
                const sellValueUSD = sellValuePerShare * quantity
                const sellValuePLN = sellValueUSD * sellExchangeRate
                return {
                    buyDate: detail.purchaseDate,
                    quantity,
                    buyValuePerShare,
                    buyValueUSD,
                    buyExchangeRate,
                    buyValuePLN,
                    sellValuePerShare,
                    sellValueUSD,
                    sellExchangeRate,
                    sellValuePLN,
                    coveredStatus: detail.coveredStatus
                }
            })

    const processSaleDetails = sale => {
        const saleDateString = sale.order.uniqueFillDate || sale.withdrawalDate
        return getExchangeRate(new Date(saleDateString))
            .then(sellExchangeRate => {
                const longTermCostTransactions = (sale.costBasis.longTerm && sale.costBasis.longTerm.rows) || []
                const shortTermCostTransactions = (sale.costBasis.shortTerm && sale.costBasis.shortTerm.rows) || []
                return Promise.all(longTermCostTransactions.concat(shortTermCostTransactions).map(detail => processSaleDetail(detail, sellExchangeRate)))
                    .then(details => {
                        const transactionFeeUSD = Number(sale.summary.summarySold.fees.amount)
                        const transactionFeePLN = transactionFeeUSD * sellExchangeRate
                        return {
                            transactionDate: saleDateString,
                            settlementDate: sale.settlementDate,
                            quantity: details.reduce((acc, curr) => acc + curr.quantity , 0),
                            transactionFeeUSD,
                            transactionFeePLN,
                            transactionDetails: details,
                            sellExchangeRate,
                            sellValueUSD: details.reduce((acc, curr) => acc + curr.sellValueUSD , 0),
                            sellValuePLN: details.reduce((acc, curr) => acc + curr.sellValuePLN , 0),
                            buyValuePLN: details.reduce((acc, curr) => acc + curr.buyValuePLN , 0)
                        }
                    })
            })
    }

    console.info('fetching data...')

    const isStockSaleRecord = record =>
        record.txApiType.includes('WITHDRAWAL') && record.fundType === 'STOCK'

    const getSaleRecords = () =>
        fetchHistoryRecords()
            .then(records => records.filter(record => isStockSaleRecord(record) && (new Date(record.settlementDate)).getFullYear() === theYear))
            .then(sales => Promise.all(sales.map(sale => sale.txApiType === 'WITHDRAWAL_REALTIME_TRANSACTION' ? fetchRtSaleDetails(sale.realtimeTransactionPK) : fetchSaleDetails(sale.spfWithdrawalPK))))
            .then(salesDetails => Promise.all(salesDetails.filter(saleDetails => !!saleDetails.costBasis).map(processSaleDetails)))

    Promise.all([
        getSaleRecords(),
        getDividendRecords()
    ])
    .then(([sales, dividends]) => {
        const data = [];
        if (sales.length) {
            data.push('sales summary:')
            data.push(sales.map(sale => ({
                'date': sale.transactionDate,
                'settlement date': sale.settlementDate,
                'quantity': sale.quantity.toFixed(2),
                'exchange rate': sale.sellExchangeRate.toFixed(2),
                'earnings usd': sale.sellValueUSD.toFixed(2),
                'earnings pln': sale.sellValuePLN.toFixed(2),
                'cost pln': sale.buyValuePLN.toFixed(2),
                'fees usd': sale.transactionFeeUSD.toFixed(2),
                'fees pln': sale.transactionFeePLN.toFixed(2),
                'cost + fees pln': (sale.buyValuePLN + sale.transactionFeePLN).toFixed(2)
            })))

            const totalEarnings = sales.reduce((acc, curr) => acc + curr.sellValuePLN , 0)
            const totalCosts = sales.reduce((acc, curr) => acc + curr.buyValuePLN + curr.transactionFeePLN, 0)
            data.push('total earnings pln (PIT-38 p. 22): ' + totalEarnings.toFixed(2))
            data.push('total earnings cost (with fees) pln (PIT-38 p. 23): ' + totalCosts.toFixed(2))
            data.push('total profit pln (PIT/ZG p. 32): ' + (totalEarnings - totalCosts).toFixed(2))

            sales.forEach(sale => {
                data.push(`breakdown of sale from ${sale.transactionDate}:`)
                data.push(sale.transactionDetails.map(detail => ({
                    'buy date': detail.buyDate,
                    'quantity': detail.quantity.toFixed(2),
                    'buy value per share': detail.buyValuePerShare.toFixed(2),
                    'buy value usd': detail.buyValueUSD.toFixed(2),
                    'buy exchange rate': detail.buyExchangeRate.toFixed(2),
                    'buy value pln': detail.buyValuePLN.toFixed(2),
                    'sell value per share': detail.sellValuePerShare.toFixed(2),
                    'sell value usd': detail.sellValueUSD.toFixed(2),
                    'sell exchange rate': detail.sellExchangeRate.toFixed(2),
                    'sell value pln': detail.sellValuePLN.toFixed(2),
                    'covered status': detail.coveredStatus
                })))
            })
        } else {
            console.info(`seems like you have no sales for ${theYear}, but please double check just in case`)
        }
        if (dividends.length) {
            data.push('dividends summary:')
            data.push(dividends.map(dividend => ({
                'date': dividend.date,
                'exchange rate': dividend.exchangeRate.toFixed(2),
                'amount usd': dividend.amountUSD.toFixed(2),
                'amount pln': dividend.amountPLN.toFixed(2)
            })))
            const totalDividendEarning = dividends.reduce((total, dividend) => total + dividend.amountPLN, 0)
            data.push('total dividend earnings pln: ' + totalDividendEarning.toFixed(2))
            const pitHints = sales.length ?
                ['PIT-38 p. 45', 'PIT-38 p. 46'] :
                ['PIT-36 p. 387', 'PIT-36 p. 389']
            data.push(`total dividend 19% tax pln (${pitHints[0]}): ${(totalDividendEarning * 0.19).toFixed(2)}`)
            data.push(`total dividend 15% (*) tax withhold (${pitHints[1]}): ${(totalDividendEarning * 0.15).toFixed(2)}`)
            data.push('(*) Assuming you filled in W-8BEN. Otherwise adjust this number')
        } else {
            console.info(`seems like you got no dividends in ${theYear}, but please double check just in case`)
        }
        download(stringifyData(data))
    })
})()
